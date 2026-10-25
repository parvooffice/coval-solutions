"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, MetricCard, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { fmt } from "../data/dashboard-data";
import { apiRequest } from "../lib/client-api";

function connectionKey(person) {
  return person.covalUserId ? `member:${person.covalUserId}` : `github:${person.login.toLowerCase()}`;
}

export default function PeoplePage({ navigate, notify }) {
  const { people, teams, metrics, pullRequests, dashboard, currentUser } = useDashboardData();
  const [members, setMembers] = useState([]);
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("All people");
  const [connections, setConnections] = useState(new Set());
  const [connectionBusy, setConnectionBusy] = useState("");
  const githubIdentity = currentUser?.identities?.find((identity) => identity.provider === "github");
  const ownLogin = dashboard.primaryProfile?.login || githubIdentity?.identity_data?.user_name || githubIdentity?.identity_data?.login || "";

  useEffect(() => {
    let active = true;
    async function refreshDirectory() {
      try {
        const { members: savedMembers } = await apiRequest("/api/members");
        if (active) setMembers(savedMembers || []);
      } catch {}
    }
    async function loadConnections() {
      try {
        const { connections: saved = [], memberConnections = [] } = await apiRequest("/api/connections");
        if (active) setConnections(new Set([
          ...saved.map((connection) => `github:${connection.target_github_login.toLowerCase()}`),
          ...memberConnections.map((connection) => `member:${connection.target_user_id}`),
        ]));
      } catch {}
    }
    refreshDirectory();
    loadConnections();
    const timer = window.setInterval(() => { refreshDirectory(); loadConnections(); }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  async function toggleConnection(person) {
    if ((!person.login && !person.covalUserId) || connectionBusy) return;
    const key = connectionKey(person);
    const isConnected = connections.has(key);
    setConnectionBusy(key);
    try {
      const target = person.covalUserId ? { userId: person.covalUserId } : { login: person.login };
      await apiRequest("/api/connections", { method: isConnected ? "DELETE" : "POST", body: JSON.stringify(target) });
      setConnections((current) => {
        const next = new Set(current);
        if (isConnected) next.delete(key);
        else next.add(key);
        return next;
      });
      notify?.(isConnected ? `Disconnected from ${person.name}.` : `You're now connected with ${person.name}.`);
    } catch (error) { notify?.(error.message); }
    finally { setConnectionBusy(""); }
  }

  const directoryPeople = useMemo(() => {
    const byLogin = new Map(people.map((person) => [person.login.toLowerCase(), { ...person, covalUserId: "", isActive: false }]));
    members.forEach((member) => {
      const loginKey = member.githubLogin.toLowerCase();
      const current = loginKey ? byLogin.get(loginKey) : null;
      if (current) {
        byLogin.set(loginKey, { ...current, covalUserId: member.userId, memberSince: member.createdAt, lastSeenAt: member.lastSeenAt, isActive: member.isActive });
        return;
      }
      const name = member.name || member.githubLogin || "COVAL member";
      byLogin.set(member.githubLogin ? `member:${member.userId}` : `member:${member.userId}`, {
        id: member.githubLogin || `member-${member.userId}`,
        covalUserId: member.userId,
        login: member.githubLogin,
        name,
        initials: name.trim().split(/[\s-]+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase() || "CV",
        avatar: member.avatar,
        url: member.githubLogin ? `https://github.com/${member.githubLogin}` : "",
        role: member.githubLogin ? "COVAL member" : "Community member",
        team: "",
        teams: [],
        location: "",
        company: "",
        bio: "",
        color: "mint",
        commits: 0,
        prs: 0,
        reviews: 0,
        repositories: [],
        isActive: member.isActive,
        lastSeenAt: member.lastSeenAt,
        memberSince: member.createdAt,
      });
    });
    return [...byLogin.values()];
  }, [members, people]);

  const filtered = useMemo(() => directoryPeople.filter((person) => {
    const matchesQuery = `${person.name} ${person.login || ""} ${person.role} ${person.team} ${person.bio}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (team === "All people" || person.teams?.includes(team));
  }), [directoryPeople, query, team]);

  return (
    <>
      <PageHeading eyebrow={`COVAL COMMUNITY / ${directoryPeople.length} PEOPLE`} title="Engineering, connected." description="COVAL members appear alongside public GitHub contributors. Active status updates while a member is using the app." action={<button type="button" className="button button-quiet" onClick={() => navigate("network")}><Icon name="network" size={17} /> Explore network</button>} />
      <section className="summary-grid" aria-label="Engineering team summary">
        <MetricCard label="COVAL MEMBERS & CONTRIBUTORS" value={fmt(directoryPeople.length)} detail={`${fmt(members.filter((member) => member.isActive).length)} active in the last 3 minutes`} />
        <MetricCard label="REPOSITORY CONTRIBUTIONS" value={fmt(metrics.repositoryCommits || 0)} detail="GitHub contributor counts summed across repositories" />
        <MetricCard label="MERGED PULL REQUESTS" value={fmt(metrics.mergedPullRequests || 0)} detail="Across the configured organization" />
        <MetricCard label="ACTIVE TEAMS" value={fmt(metrics.activeTeams || 0)} detail={`${fmt(metrics.teams || 0)} GitHub teams configured`} />
      </section>
      <div className="directory-toolbar">
        <label className="search-field"><Icon name="search" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search COVAL members…" aria-label="Search people" /></label>
        <div className="filter-pills" aria-label="Filter people by team">
          {["All people", ...teams.map((item) => item.name)].map((name) => <button key={name} type="button" className={`filter-pill${team === name ? " selected" : ""}`} aria-pressed={team === name} onClick={() => setTeam(name)}>{name}</button>)}
        </div>
      </div>
      {filtered.length ? <div className="people-grid">
        {filtered.map((person) => <article className="person-card" key={person.id}>
          <div className="person-card-head"><button type="button" className="person-card-avatar-button" aria-label={`View ${person.name} profile`} onClick={() => navigate(`profile/${person.id}`)}><Avatar initials={person.initials} name={person.name} color={person.color} size="lg" src={person.avatar} online={person.isActive} /></button><span className={`person-status${person.isActive ? " is-active" : ""}`}><i />{person.isActive ? "Active now" : person.login ? "GitHub" : "COVAL member"}</span></div>
          <div className="person-card-identity"><h2>{person.name}</h2><p className="person-role">{person.login ? `@${person.login}` : "COVAL community member"}</p>{person.teams?.map((name) => <span className="team-tag" key={name}>{name}</span>)}</div>
          {person.login ? <div className="person-card-stats"><span><b>{fmt(person.commits || 0)}</b><small>repo commits</small></span><span><b>{fmt(person.prs || 0)}</b><small>merged PRs seen</small></span><span><b>{person.repositories.length}</b><small>repositories</small></span></div> : <div className="person-card-stats person-community-note"><span><small>Joined COVAL {person.memberSince ? new Date(person.memberSince).toLocaleDateString() : ""}</small></span></div>}
          <div className="person-card-footer"><span><Icon name="activity" size={14} />{person.location || person.company || (person.login ? "GitHub" : "COVAL")}</span>{(person.login || person.covalUserId) && <button type="button" className={`button person-connect-button${connections.has(connectionKey(person)) ? " button-connected" : " button-quiet"}`} disabled={connectionBusy === connectionKey(person) || person.covalUserId === currentUser?.id || (!person.covalUserId && person.login.toLowerCase() === ownLogin.toLowerCase())} onClick={() => toggleConnection(person)}><Icon name={connections.has(connectionKey(person)) ? "check" : "plus"} size={14} />{connectionBusy === connectionKey(person) ? "Saving…" : connections.has(connectionKey(person)) ? "Connected" : "Connect"}</button>}{person.url && <a className="quiet-icon" href={person.url} target="_blank" rel="noreferrer" aria-label={`Open ${person.name} on GitHub`}><Icon name="arrowUpRight" size={16} /></a>}</div>
        </article>)}
      </div> : <div className="empty-state"><Icon name="users" size={22} /><strong>{directoryPeople.length ? "No teammates match" : "No COVAL members or GitHub people loaded"}</strong><p>{directoryPeople.length ? "Try another name or team." : "Signed-in COVAL members and GitHub contributors will appear here."}</p></div>}
      <p className="project-footer-note">Merged pull request counts on individual cards reflect pull requests indexed in the recent repository window ({pullRequests.length} PRs loaded).</p>
    </>
  );
}
