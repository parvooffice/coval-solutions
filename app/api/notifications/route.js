import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ notifications: [] });
    const rows = await supabaseRest(user, `coval_notifications?select=id,actor_id,kind,created_at,read_at&recipient_id=eq.${user.id}&order=created_at.desc&limit=30`);
    const actorIds = [...new Set((rows || []).map((row) => row.actor_id))];
    const profiles = actorIds.length
      ? await supabaseRest(user, `coval_profiles?select=user_id,github_login,display_name,avatar_url&user_id=in.(${actorIds.join(",")})`)
      : [];
    const profilesById = new Map((profiles || []).map((profile) => [profile.user_id, profile]));
    const notifications = (rows || []).map((row) => {
      const actor = profilesById.get(row.actor_id);
      return {
        id: row.id,
        kind: row.kind,
        createdAt: row.created_at,
        readAt: row.read_at,
        actor: {
          id: row.actor_id,
          covalUserId: row.actor_id,
          login: actor?.github_login || "",
          name: actor?.display_name || actor?.github_login || "A COVAL member",
          avatar: actor?.avatar_url || "",
        },
      };
    });
    return Response.json({ notifications }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function PATCH(request) {
  try {
    const user = await requireUser(request);
    const { notificationId, all } = await request.json();
    if (all === true) {
      await supabaseRest(user, `coval_notifications?recipient_id=eq.${encodeURIComponent(user.id)}&read_at=is.null`, {
        method: "PATCH",
        body: JSON.stringify({ read_at: new Date().toISOString() }),
      });
      return Response.json({ updated: true });
    }
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
