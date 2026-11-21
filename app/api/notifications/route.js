import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 40;

// Each switch in Settings → Notifications. Missing settings (or before the migration is run) mean "on".
export const SETTING_KEYS = ["messages", "jobs", "scores", "issues", "post_activity", "social", "desktop_popups"];
const DEFAULT_SETTINGS = Object.fromEntries(SETTING_KEYS.map((key) => [key, true]));

// Which switch controls each kind of stored notification and Feed post.
const STORED_KIND_SETTING = { connection: "social", team_invite: "social", post_interest: "post_activity", interest_accepted: "post_activity" };
const POST_KIND_SETTING = { job: "jobs", team: "jobs", showcase: "scores", issue: "issues" };

async function loadSettings(user) {
  try {
    const rows = await supabaseRest(user, `coval_notification_settings?select=${SETTING_KEYS.join(",")},feed_seen_at&user_id=eq.${user.id}&limit=1`);
    if (rows?.[0]) return { settings: rows[0], available: true };
    // First visit: start the "seen" clock now so old Feed posts don't all show as new.
    const created = await supabaseRest(user, "coval_notification_settings", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
      body: JSON.stringify({ user_id: user.id }),
    });
    return { settings: created?.[0] || { ...DEFAULT_SETTINGS, feed_seen_at: new Date().toISOString() }, available: true };
  } catch {
    // The notification settings migration hasn't been run yet.
    return { settings: { ...DEFAULT_SETTINGS, feed_seen_at: null }, available: false };
  }
}

function clip(text, length) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

async function unreadMessages(user, since) {
  const memberships = await supabaseRest(user, `coval_conversation_members?select=conversation_id,last_read_at,joined_at&user_id=eq.${user.id}`);
  if (!memberships?.length) return [];
  const readUntil = new Map(memberships.map((row) => [row.conversation_id, row.last_read_at || row.joined_at]));
  const ids = memberships.map((row) => row.conversation_id).join(",");
  const rows = await supabaseRest(user, `coval_messages?select=id,conversation_id,content,sender_id,created_at&conversation_id=in.(${ids})&sender_id=neq.${user.id}&created_at=gt.${encodeURIComponent(since)}&order=created_at.desc&limit=60`);
  // One notification per conversation: the newest unread message, with how many are unread.
  const byConversation = new Map();
  for (const row of rows || []) {
    const lastRead = readUntil.get(row.conversation_id);
    if (lastRead && new Date(row.created_at) <= new Date(lastRead)) continue;
    const entry = byConversation.get(row.conversation_id);
    if (entry) entry.count += 1;
    else byConversation.set(row.conversation_id, { latest: row, count: 1 });
  }
  return [...byConversation.values()];
}

async function recentPosts(user, settings, since) {
  const rows = await supabaseRest(user, "rpc/coval_public_feed", { method: "POST", body: JSON.stringify({ feed_kind: null, max_rows: 40 }) });
  return (rows || []).filter((post) => post.author_id !== user.id
    && !post.closed
    && new Date(post.created_at) > new Date(since)
    && settings[POST_KIND_SETTING[post.kind]]);
}

const POST_TEXT = {
  job: (post) => `posted a job: ${clip(post.title, 70)}`,
  team: (post) => `is forming a team: ${clip(post.title, 70)}`,
  showcase: (post) => `shared a score: ${clip(post.title, 70)}`,
  issue: (post) => `needs help with an issue: ${clip(post.title, 70)}`,
};

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ notifications: [], settings: DEFAULT_SETTINGS, settingsAvailable: false });
    const { settings, available } = await loadSettings(user);
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const seenAt = settings.feed_seen_at ? new Date(settings.feed_seen_at) : null;
    const virtualReadAt = (createdAt) => (seenAt && new Date(createdAt) <= seenAt ? seenAt.toISOString() : null);

    const [rows, messages, posts] = await Promise.all([
      supabaseRest(user, `coval_notifications?select=id,actor_id,kind,team_id,created_at,read_at&recipient_id=eq.${user.id}&order=created_at.desc&limit=30`),
      settings.messages ? unreadMessages(user, since).catch(() => []) : [],
      settings.jobs || settings.scores || settings.issues ? recentPosts(user, settings, since).catch(() => []) : [],
    ]);
    const stored = (rows || []).filter((row) => settings[STORED_KIND_SETTING[row.kind] || "social"]);

    const actorIds = [...new Set([...stored.map((row) => row.actor_id), ...messages.map((item) => item.latest.sender_id)])];
    const profiles = actorIds.length
      ? await supabaseRest(user, `coval_profiles?select=user_id,github_login,display_name,avatar_url&user_id=in.(${actorIds.join(",")})`)
      : [];
    const profilesById = new Map((profiles || []).map((profile) => [profile.user_id, profile]));
    const actorFor = (id) => {
      const actor = profilesById.get(id);
      return { id, covalUserId: id, login: actor?.github_login || "", name: actor?.display_name || actor?.github_login || "A COVAL member", avatar: actor?.avatar_url || "" };
    };
    const teamIds = [...new Set(stored.map((row) => row.team_id).filter(Boolean))];
    const teams = teamIds.length ? await supabaseRest(user, `coval_teams?select=id,name&id=in.(${teamIds.join(",")})`) : [];
    const teamNames = new Map((teams || []).map((team) => [team.id, team.name]));

    const notifications = [
      ...stored.map((row) => ({
        id: row.id,
        kind: row.kind,
        team: row.team_id ? { id: row.team_id, name: teamNames.get(row.team_id) || "a team" } : null,
        createdAt: row.created_at,
        readAt: row.read_at,
        actor: actorFor(row.actor_id),
      })),
      ...messages.map(({ latest, count }) => ({
        id: `message-${latest.id}`,
        kind: "message",
        conversationId: latest.conversation_id,
        text: count > 1 ? `sent you ${count} messages` : `sent you a message: “${clip(latest.content, 80)}”`,
        createdAt: latest.created_at,
        readAt: virtualReadAt(latest.created_at),
        actor: actorFor(latest.sender_id),
      })),
      ...posts.map((post) => ({
        id: `post-${post.id}`,
        kind: `feed_${post.kind}`,
        postId: post.id,
        text: (POST_TEXT[post.kind] || POST_TEXT.showcase)(post),
        createdAt: post.created_at,
        readAt: virtualReadAt(post.created_at),
        actor: { id: post.author_id, covalUserId: post.author_id, login: post.author_login || "", name: post.author_name || "A COVAL member", avatar: post.author_avatar || "" },
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, MAX_ITEMS);

    const publicSettings = Object.fromEntries(SETTING_KEYS.map((key) => [key, settings[key] !== false]));
    return Response.json({ notifications, settings: publicSettings, settingsAvailable: available }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request) {
  try {
    const user = await requireUser(request);
    const body = await request.json();

    if (body.settings && typeof body.settings === "object") {
      const changes = Object.fromEntries(SETTING_KEYS.filter((key) => typeof body.settings[key] === "boolean").map((key) => [key, body.settings[key]]));
      if (!Object.keys(changes).length) return Response.json({ error: "Choose a setting to change." }, { status: 400 });
      try {
        await supabaseRest(user, "coval_notification_settings?on_conflict=user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: user.id, ...changes, updated_at: new Date().toISOString() }),
        });
      } catch {
        return Response.json({ error: "Notification settings aren't set up yet. Run the 202611220001_coval_notification_settings migration in Supabase." }, { status: 503 });
      }
      return Response.json({ updated: true });
    }

    if (body.all === true) {
      const now = new Date().toISOString();
      await Promise.all([
        supabaseRest(user, `coval_notifications?recipient_id=eq.${encodeURIComponent(user.id)}&read_at=is.null`, {
          method: "PATCH",
          body: JSON.stringify({ read_at: now }),
        }),
        // Messages and Feed posts before this moment show as read in the bell.
        supabaseRest(user, "coval_notification_settings?on_conflict=user_id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({ user_id: user.id, feed_seen_at: now }),
        }).catch(() => null),
      ]);
      return Response.json({ updated: true });
    }

    const { notificationId } = body;
    if (!uuidPattern.test(notificationId || "")) return Response.json({ error: "Choose a valid notification." }, { status: 400 });
    await supabaseRest(user, `coval_notifications?recipient_id=eq.${encodeURIComponent(user.id)}&id=eq.${encodeURIComponent(notificationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    });
    return Response.json({ updated: true });
  } catch (error) {
    return apiError(error);
  }
}
