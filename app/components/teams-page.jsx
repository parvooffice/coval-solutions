import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, PageHeading } from "./ui";
import { AGENTS, formatScore, gradeFor } from "./evaluation-report";
import { apiRequest } from "../lib/client-api";
import { isGuest } from "../lib/guest";

function initials(name = "COVAL member") {
  return name.trim().split(/[\s-]+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "CV";
}

const agentLabel = (id) => AGENTS.find((agent) => agent.id === id)?.label || id;

// Development-only sample so both dashboards can be previewed without a signed-in team.
function sampleData(role) {
  const scores = (base) => Object.fromEntries(AGENTS.map((agent, index) => [agent.id, { label: agent.label, average: Math.max(20, Math.min(98, base + ((index * 17) % 29) - 14)) }]));
  const member = (userId, name, memberRole, base, status = "active") => ({
    userId, name, login: name.split(" ")[0].toLowerCase(), avatar: "", role: memberRole, status, isYou: userId === "me",
    summary: status === "active" ? { repositories: 2, overall: base, agents: scores(base), weakest: { id: "test_coverage", label: "Test coverage", average: base - 18 }, lastEvaluated: "2026-11-19T10:00:00Z", topFixes: [{ title: "Add tests for this module", location: "src/billing.py", agent: "Test coverage", repository: "payments-api" }, { title: "Network call without a timeout", location: "src/client.js:42", agent: "Scalability", repository: "web-app" }] } : undefined,
  });
  const members = [member("me", "You (preview)", role, 74), member("u2", "Ava Patel", "admin", 82), member("u3", "Liam Chen", "member", 61), member("u4", "Mia Rossi", "member", 0, "invited")];
  return {
    teams: [{ id: "sample", name: "Platform team", role }],
    invites: [{ id: "sample-invite", name: "Design systems guild", invitedAt: "2026-11-18T09:00:00Z" }],
    team: {
      id: "sample", name: "Platform team", role,
      members: role === "admin" ? members : members.map(({ summary, ...rest }) => rest),
      averages: AGENTS.map((agent, index) => ({ id: agent.id, label: agent.label, average: 50 + ((index * 23) % 45), repositories: 6, members: 3 })),
      mine: { repositories: 2, overall: 74, agents: scores(74), weakest: { id: "test_coverage", label: "Test coverage", average: 56 }, topFixes: [] },
    },
    signedIn: true,
  };
}

function ScoreBar({ value, compare, label }) {
  return <div className="team-bar" title={label}>
    <span className={`team-bar-fill eval-grade-${gradeFor(value) || "none"}`} style={{ width: `${Math.max(2, Math.min(100, value || 0))}%` }} />
    {compare != null && <span className="team-bar-marker" style={{ left: `${Math.min(100, compare)}%` }} title={`Team average ${formatScore(compare)}`} />}
  </div>;
}

export default function TeamsPage({ navigate, notify }) {
  const [data, setData] = useState(null);
  const [teamId, setTeamId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [creating, setCreating] = useState(false);
  const [directory, setDirectory] = useState([]);
  const [inviteQuery, setInviteQuery] = useState("");
  const [expanded, setExpanded] = useState("");
  const [sample, setSample] = useState("");

  const load = useCallback(async (nextTeamId = teamId) => {
    if (sample) return;
    try {
      const result = await apiRequest(`/api/teams${nextTeamId ? `?teamId=${encodeURIComponent(nextTeamId)}` : ""}`);
      setData(result);
      setError("");
    } catch (cause) {
      setError(cause.message || "Could not load your teams.");
    } finally {
      setLoading(false);
    }
  }, [teamId, sample]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (sample) setData(sampleData(sample)); }, [sample]);

  const team = data?.team;
  const isAdmin = team?.role === "admin";
  useEffect(() => {
    if (!isAdmin || sample) return;
    apiRequest("/api/members").then(({ members = [] }) => setDirectory(members)).catch(() => {});
  }, [isAdmin, sample]);

  async function act(payload, success, key) {
    if (sample) { notify?.("Preview only — nothing was saved."); return; }
    setBusy(key || payload.action);
    setError("");
    try {
      const result = await apiRequest("/api/teams", { method: "POST", body: JSON.stringify(payload) });
      if (success) notify?.(success);
      const next = payload.action === "create" ? result.teamId : payload.action === "respond" && payload.accept ? payload.teamId : teamId;
      if (next !== teamId) setTeamId(next || "");
      await load(next);
      return result;
    } catch (cause) {
      setError(cause.message || "That team change did not go through.");
    } finally {
      setBusy("");
    }
  }

  const rosterIds = useMemo(() => new Set((team?.members || []).map((member) => member.userId)), [team]);
  const inviteMatches = useMemo(() => {
    const query = inviteQuery.trim().toLowerCase();
    if (!query) return [];
    return directory.filter((member) => !rosterIds.has(member.userId) && `${member.name} ${member.githubLogin}`.toLowerCase().includes(query)).slice(0, 6);
  }, [directory, inviteQuery, rosterIds]);

  const averages = useMemo(() => [...(team?.averages || [])].sort((a, b) => a.average - b.average), [team]);
  const teamOverall = averages.length ? averages.reduce((sum, item) => sum + item.average, 0) / averages.length : null;
  const active = (team?.members || []).filter((member) => member.status === "active");
  const pending = (team?.members || []).filter((member) => member.status === "invited");
  const adminCount = active.filter((member) => member.role === "admin").length;

  const createForm = <form className="team-create" onSubmit={async (event) => { event.preventDefault(); const result = await act({ action: "create", name: newTeamName }, `Created ${newTeamName.trim()}.`); if (result) { setNewTeamName(""); setCreating(false); } }}>
    <input value={newTeamName} onChange={(event) => setNewTeamName(event.target.value)} maxLength={80} placeholder="Team name, e.g. Platform team" aria-label="New team name" />
    <button type="submit" className="button button-primary" disabled={busy === "create" || newTeamName.trim().length < 2}><Icon name="plus" size={15} /> {busy === "create" ? "Creating…" : "Create team"}</button>
  </form>;

  return <>
    <PageHeading
      eyebrow="COVAL / TEAMS"
      title="Teams"
      description="Create a team, invite members, and track code health together. Admins see every member's scores; members see their own next to the team average."
      action={data?.teams?.length > 0 && !creating ? <button type="button" className="button button-quiet" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> New team</button> : null}
    />
    {sample && <div className="nt-sample-banner" role="status"><Icon name="info" size={15} /><span><strong>Sample team ({sample} view).</strong> Development preview only — nothing is saved.</span><button type="button" className="button button-quiet" onClick={() => setSample(sample === "admin" ? "member" : "admin")}>Switch to {sample === "admin" ? "member" : "admin"} view</button><button type="button" className="button button-quiet" onClick={() => { setSample(""); setData(null); setLoading(true); load(); }}>Exit preview</button></div>}
    {error && <div className="backend-status-banner" role="alert"><div><strong>Team update needs attention.</strong><p>{error}</p></div><button type="button" className="button" onClick={() => setError("")}>Dismiss</button></div>}

    {data?.invites?.length > 0 && <section className="team-invites surface-card" aria-label="Team invites">
      <span className="eyebrow">PENDING INVITES</span>
      {data.invites.map((invite) => <div className="team-invite-row" key={invite.id}>
        <span><Icon name="briefcase" size={16} /> You're invited to join <strong>{invite.name}</strong>. Admins of this team will be able to see your evaluation scores.</span>
        <div><button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={() => act({ action: "respond", teamId: invite.id, accept: true }, `Joined ${invite.name}.`, `respond-${invite.id}`)}>Accept</button><button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={() => act({ action: "respond", teamId: invite.id, accept: false }, "Invite declined.", `respond-${invite.id}`)}>Decline</button></div>
      </div>)}
    </section>}

    {creating && <section className="surface-card team-create-card"><span className="eyebrow">NEW TEAM</span>{createForm}<button type="button" className="text-button" onClick={() => setCreating(false)}>Cancel</button></section>}

    {loading && !data ? <div className="empty-state"><Icon name="briefcase" size={22} /><strong>Loading your teams…</strong></div>
      : !data?.signedIn ? <div className="empty-state"><Icon name="briefcase" size={22} /><strong>Sign in to use teams</strong><p>Teams use your COVAL account to share evaluation results.</p>{(import.meta.env.DEV || isGuest()) && <div className="team-preview-actions"><button type="button" className="button button-quiet" onClick={() => setSample("admin")}>Preview admin view</button><button type="button" className="button button-quiet" onClick={() => setSample("member")}>Preview member view</button></div>}</div>
      : !data.teams.length ? <section className="empty-state surface-card team-empty"><Icon name="briefcase" size={22} /><strong>You're not in a team yet</strong><p>Create one and invite COVAL members, or accept an invite above.</p>{createForm}</section>
      : <>
        {data.teams.length > 1 && <div className="nt-segmented team-switcher" role="tablist" aria-label="Your teams">{data.teams.map((item) => <button key={item.id} type="button" role="tab" aria-selected={item.id === team?.id} className={item.id === team?.id ? "is-active" : ""} onClick={() => { setTeamId(item.id); load(item.id); }}>{item.name}</button>)}</div>}

        {team && <>
          <section className="team-header surface-card">
            <div><span className="eyebrow">{isAdmin ? "TEAM ADMIN" : "TEAM MEMBER"}</span><h2>{team.name}</h2><p>{active.length} {active.length === 1 ? "member" : "members"}{pending.length ? ` · ${pending.length} pending ${pending.length === 1 ? "invite" : "invites"}` : ""}</p></div>
            <div className="team-header-stats">
              <div><strong>{formatScore(teamOverall)}</strong><small>Team average</small></div>
              <div><strong>{formatScore(team.mine?.overall)}</strong><small>Your average</small></div>
              <div><strong>{averages[0] ? agentLabel(averages[0].id) : "—"}</strong><small>Weakest team area</small></div>
            </div>
          </section>

          <section className="team-agents surface-card" aria-label="Agent averages">
            <div className="team-section-head"><div><span className="eyebrow">{isAdmin ? "TEAM CODE HEALTH" : "YOU VS THE TEAM"}</span><h3>{isAdmin ? "Average score per agent" : "Your score per agent, with the team average marked"}</h3></div>{!isAdmin && <span className="team-legend"><i /> Team average</span>}</div>
            {averages.length ? <div className="team-agent-rows">
              {averages.map((item) => {
                const mine = team.mine?.agents?.[item.id]?.average;
                const value = isAdmin ? item.average : mine;
                return <div className="team-agent-row" key={item.id}>
                  <span className="team-agent-name">{agentLabel(item.id)}</span>
                  <ScoreBar value={value} compare={isAdmin ? null : item.average} label={`${agentLabel(item.id)}: ${formatScore(value)}`} />
                  <span className="team-agent-score">{formatScore(value)}{!isAdmin && <small> / team {formatScore(item.average)}</small>}</span>
                </div>;
              })}
            </div> : <p className="team-muted">No scores yet. Members' results appear here after they score repositories in Code Evaluation.</p>}
            {!isAdmin && team.mine?.repositories === 0 && <button type="button" className="button button-primary" onClick={() => navigate("code-evaluation")}><Icon name="code" size={15} /> Score your repositories</button>}
          </section>

          <section className="team-members surface-card" aria-label="Team members">
            <div className="team-section-head"><div><span className="eyebrow">MEMBERS</span><h3>{isAdmin ? "Scores by member" : "Who's on the team"}</h3></div></div>
            {isAdmin && <div className="team-invite">
              <label className="nt-search"><Icon name="search" size={14} /><input value={inviteQuery} onChange={(event) => setInviteQuery(event.target.value)} placeholder="Invite a COVAL member by name or GitHub username" aria-label="Find a member to invite" /></label>
              {inviteMatches.length > 0 && <ul className="team-invite-results">{inviteMatches.map((member) => <li key={member.userId}>
                <Avatar initials={initials(member.name)} name={member.name} size="sm" src={member.avatar} />
                <span><strong>{member.name}</strong><small>{member.githubLogin ? `@${member.githubLogin}` : "COVAL member"}</small></span>
                <button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={async () => { await act({ action: "invite", teamId: team.id, userId: member.userId }, `Invited ${member.name}.`, `invite-${member.userId}`); setInviteQuery(""); }}><Icon name="plus" size={14} /> Invite</button>
              </li>)}</ul>}
              {inviteQuery.trim() && !inviteMatches.length && <p className="team-muted">No COVAL members match. People must sign in to COVAL once before they can be invited.</p>}
            </div>}
            <ul className="team-member-list">
              {(team.members || []).map((member) => {
                const summary = member.summary;
                const open = expanded === member.userId;
                return <li key={member.userId} className={member.status === "invited" ? "is-pending" : ""}>
                  <div className="team-member-row">
                    <button type="button" className="team-member-person" onClick={() => member.login && !sample && navigate(`profile/${member.login}`)}>
                      <Avatar initials={initials(member.name)} name={member.name} size="md" src={member.avatar} />
                      <span><strong>{member.name}{member.isYou && !sample ? " (you)" : ""}</strong><small>{member.status === "invited" ? "Invite pending" : member.login ? `@${member.login}` : "COVAL member"}</small></span>
                    </button>
                    <span className={`team-role is-${member.role}`}>{member.role === "admin" ? "Admin" : "Member"}</span>
                    {isAdmin && summary && <>
                      <span className="team-member-stat"><strong>{formatScore(summary.overall)}</strong><small>{summary.repositories} {summary.repositories === 1 ? "repo" : "repos"}</small></span>
                      <span className="team-member-stat team-member-weakest"><strong>{summary.weakest ? summary.weakest.label : "—"}</strong><small>{summary.weakest ? `weakest · ${formatScore(summary.weakest.average)}` : "not scored yet"}</small></span>
                    </>}
                    {isAdmin && <div className="team-member-actions">
                      {summary?.topFixes?.length > 0 && <button type="button" className="button button-quiet" aria-expanded={open} onClick={() => setExpanded(open ? "" : member.userId)}>{open ? "Hide fixes" : "Top fixes"}</button>}
                      {member.status === "active" && !(member.role === "admin" && adminCount <= 1) && <button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={() => act({ action: "role", teamId: team.id, userId: member.userId, role: member.role === "admin" ? "member" : "admin" }, member.role === "admin" ? `${member.name} is now a member.` : `${member.name} is now an admin.`, `role-${member.userId}`)}>{member.role === "admin" ? "Make member" : "Make admin"}</button>}
                      {!member.isYou && <button type="button" className="button button-quiet team-danger" disabled={Boolean(busy)} onClick={() => window.confirm(`${member.status === "invited" ? "Cancel the invite for" : "Remove"} ${member.name}?`) && act({ action: "remove", teamId: team.id, userId: member.userId }, member.status === "invited" ? "Invite cancelled." : `Removed ${member.name}.`, `remove-${member.userId}`)}>{member.status === "invited" ? "Cancel invite" : "Remove"}</button>}
                    </div>}
                  </div>
                  {open && summary && <ol className="team-member-fixes">{summary.topFixes.map((fix, index) => <li key={index}><strong>{fix.title}</strong> <small>· {fix.agent} · {fix.repository}</small>{fix.location && <code>{fix.location}</code>}</li>)}</ol>}
                </li>;
              })}
            </ul>
            <div className="team-footer">
              <button type="button" className="button button-quiet team-danger" disabled={Boolean(busy)} onClick={() => window.confirm(`Leave ${team.name}?${isAdmin && adminCount <= 1 && active.length > 1 ? " Make another member an admin first." : ""}`) && act({ action: "remove", teamId: team.id, userId: team.members.find((member) => member.isYou)?.userId }, `You left ${team.name}.`, "leave")}>Leave team</button>
            </div>
          </section>
        </>}
      </>}
  </>;
}
