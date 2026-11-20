import { apiError, requireUser, supabaseRest } from "../../lib/server/auth.js";
import { readSavedEvaluation } from "../code-evaluation/route.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(["create", "invite", "respond", "role", "remove"]);

function requireUuid(value, message) {
  if (!uuidPattern.test(String(value || ""))) throw Object.assign(new Error(message), { status: 400 });
  return value;
}

const round = (value) => (value == null ? null : Math.round(value * 10) / 10);
const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

// Per-agent averages, overall score, and top fixes across every repository in one member's saved report.
export function summarizeReport(report) {
  const targets = report?.targets || [];
  const byAgent = new Map();
  const fixes = [];
  for (const target of targets) {
    for (const item of target.evaluations || []) {
      if (item.status !== "complete" || typeof item.score !== "number") continue;
      if (!byAgent.has(item.id)) byAgent.set(item.id, { label: item.label, scores: [] });
      byAgent.get(item.id).scores.push(item.score);
      for (const fix of (item.fixes || []).slice(0, 1)) fixes.push({ ...fix, agent: item.label, repository: target.name, score: item.score });
    }
  }
  const agents = Object.fromEntries([...byAgent].map(([id, value]) => [id, { label: value.label, average: round(average(value.scores)) }]));
  const agentAverages = Object.values(agents).map((agent) => agent.average);
  const weakest = Object.entries(agents).sort((a, b) => a[1].average - b[1].average)[0];
  return {
    repositories: targets.length,
    overall: round(average(agentAverages)),
    agents,
    weakest: weakest ? { id: weakest[0], ...weakest[1] } : null,
    lastEvaluated: targets.map((target) => target.generatedAt).filter(Boolean).sort().at(-1) || null,
    topFixes: fixes.sort((a, b) => a.score - b.score).slice(0, 3),
  };
}

async function loadTeam(user, teamId, role) {
  const roster = await supabaseRest(user, `coval_team_members?select=user_id,role,status,joined_at,created_at&team_id=eq.${encodeURIComponent(teamId)}&order=created_at.asc`);
  const ids = roster.map((row) => row.user_id);
  const profiles = ids.length
    ? await supabaseRest(user, `coval_profiles?select=user_id,github_login,display_name,profile_name,avatar_url,profile_headline&user_id=in.(${ids.join(",")})`)
    : [];
  const profileById = new Map(profiles.map((profile) => [profile.user_id, profile]));
  const averages = await supabaseRest(user, "rpc/coval_team_agent_averages", { method: "POST", body: JSON.stringify({ team: teamId }) });

  let evaluationsById = new Map();
  const activeIds = roster.filter((row) => row.status === "active").map((row) => row.user_id);
  if (role === "admin" && activeIds.length) {
    const rows = await supabaseRest(user, `coval_code_evaluations?select=user_id,report,updated_at&user_id=in.(${activeIds.join(",")})`);
    evaluationsById = new Map(rows.map((row) => [row.user_id, row]));
  }

  const members = roster.map((row) => {
    const profile = profileById.get(row.user_id) || {};
    const evaluation = evaluationsById.get(row.user_id);
    return {
      userId: row.user_id,
      login: profile.github_login || "",
      name: profile.profile_name || profile.display_name || profile.github_login || "COVAL member",
      avatar: profile.avatar_url || "",
      headline: profile.profile_headline || "",
      role: row.role,
      status: row.status,
      joinedAt: row.joined_at,
      isYou: row.user_id === user.id,
      // Individual scores are only included for admins (and the database only returns them to admins).
      summary: role === "admin" && row.status === "active" ? summarizeReport(evaluation?.report) : undefined,
    };
  });
  return {
    members,
    averages: (averages || []).map((row) => ({ id: row.agent_id, label: row.label, average: Number(row.average_score), repositories: row.repositories, members: row.members })),
  };
}

export async function GET(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ teams: [], invites: [], team: null, signedIn: false });
    const memberships = await supabaseRest(user, `coval_team_members?select=team_id,role,status,invited_by,created_at&user_id=eq.${encodeURIComponent(user.id)}`);
    const teamIds = memberships.map((row) => row.team_id);
    const teams = teamIds.length ? await supabaseRest(user, `coval_teams?select=id,name,created_at&id=in.(${teamIds.join(",")})`) : [];
    const teamById = new Map(teams.map((team) => [team.id, team]));
    const active = memberships.filter((row) => row.status === "active" && teamById.has(row.team_id))
      .map((row) => ({ id: row.team_id, name: teamById.get(row.team_id).name, role: row.role }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const invites = memberships.filter((row) => row.status === "invited" && teamById.has(row.team_id))
      .map((row) => ({ id: row.team_id, name: teamById.get(row.team_id).name, invitedAt: row.created_at }));

    const requested = new URL(request.url).searchParams.get("teamId");
    const selected = active.find((team) => team.id === requested) || active[0] || null;
    let team = null;
    if (selected) {
      const [details, myReport] = await Promise.all([loadTeam(user, selected.id, selected.role), readSavedEvaluation(user)]);
      team = { ...selected, ...details, mine: summarizeReport(myReport) };
    }
    return Response.json({ teams: active, invites, team, signedIn: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) throw Object.assign(new Error("Sign in to manage teams."), { status: 401 });
    const body = await request.json().catch(() => ({}));
    if (!ACTIONS.has(body?.action)) throw Object.assign(new Error("Unknown team action."), { status: 400 });
    const rpc = (name, args) => supabaseRest(user, `rpc/${name}`, { method: "POST", body: JSON.stringify(args) });

    if (body.action === "create") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length < 2 || name.length > 80) throw Object.assign(new Error("Team names must be 2 to 80 characters."), { status: 400 });
      return Response.json({ teamId: await rpc("coval_create_team", { team_name: name }) });
    }
    const team = requireUuid(body.teamId, "Choose a team.");
    if (body.action === "respond") {
      if (typeof body.accept !== "boolean") throw Object.assign(new Error("Accept or decline the invite."), { status: 400 });
      return Response.json({ joined: await rpc("coval_respond_team_invite", { team, accept: body.accept }) });
    }
    const member = requireUuid(body.userId, "Choose a COVAL member.");
    if (body.action === "invite") return Response.json({ invited: await rpc("coval_invite_team_member", { team, member }) });
    if (body.action === "remove") return Response.json({ removed: await rpc("coval_remove_team_member", { team, member }) });
    if (!["admin", "member"].includes(body.role)) throw Object.assign(new Error("Choose admin or member."), { status: 400 });
    return Response.json({ updated: await rpc("coval_set_team_role", { team, member, new_role: body.role }) });
  } catch (error) {
    return apiError(error);
  }
}
