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
  const { people, dashboard, currentUser } = useDashboardData();
  const [members, setMembers] = useState([]);
  const [githubStats, setGithubStats] = useState({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("Everyone");
  const [connections, setConnections] = useState(new Set());
  const [connectedMembers, setConnectedMembers] = useState(0);
  const [connectionBusy, setConnectionBusy] = useState("");

  useEffect(() => {
    let active = true;
    async function refreshDirectory() {
      try {
        const { members: savedMembers, githubStats: savedStats } = await apiRequest("/api/members");
        if (active) {
          setMembers(savedMembers || []);
          setGithubStats(savedStats || {});
        }
      } catch {}
    }
    async function loadConnections() {
      try {
        const { connections: saved = [], memberConnections = [] } = await apiRequest("/api/connections");
        if (active) {
          setConnections(new Set([
            ...saved.map((connection) => `github:${connection.target_github_login.toLowerCase()}`),
            ...memberConnections.map((connection) => `member:${connection.target_user_id}`),
          ]));
          setConnectedMembers(memberConnections.length);
        }
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
      notify?.(isConnected ? `Disconnected from ${person.name}.` : `Connected with ${person.name}. Choose whether they appear in your Network tree.`);
    } catch (error) { notify?.(error.message); }
    finally { setConnectionBusy(""); }
  }

  const directoryPeople = useMemo(() => {
    const byLogin = new Map(people.map((person) => [person.login.toLowerCase(), { ...person, covalUserId: "", isActive: false, publicStats: githubStats[person.login.toLowerCase()] || null }]));
    members.forEach((member) => {
      const loginKey = member.githubLogin.toLowerCase();
      const current = loginKey ? byLogin.get(loginKey) : null;
      if (current) {
        byLogin.set(loginKey, { ...current, covalUserId: member.userId, memberSince: member.createdAt, lastSeenAt: member.lastSeenAt, isActive: member.isActive, publicStats: member.publicStats || null });
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
        location: "",
        company: "",
        bio: "",
        color: "mint",
        commits: member.publicStats?.commits ?? null,
        prs: member.publicStats?.pullRequests ?? null,
        reviews: 0,
        repositories: [],
        publicStats: member.publicStats || null,
        isActive: member.isActive,
        lastSeenAt: member.lastSeenAt,
        memberSince: member.createdAt,
      });
    });
    return [...byLogin.values()];
  }, [members, people, githubStats]);

  const filtered = useMemo(() => directoryPeople.filter((person) => {
    const matchesQuery = `${person.name} ${person.login || ""} ${person.role} ${person.bio}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (filter === "Everyone" || connections.has(connectionKey(person)));
  }), [directoryPeople, query, filter, connections]);

  return (
    <>
      <PageHeading eyebrow={`COVAL COMMUNITY / ${directoryPeople.length} PEOPLE`} title="Engineering, connected." description="Browse COVAL members and public GitHub contributor profiles. Connect with people and choose who to show in your network tree." action={<button type="button" className="button button-quiet" onClick={() => navigate("network")}><Icon name="network" size={17} /> Explore network</button>} />
      <section className="summary-grid" aria-label="COVAL community summary">
        <MetricCard label="COVAL MEMBERS" value={fmt(members.length)} detail={`${fmt(members.filter((member) => member.isActive).length)} active in the last 3 minutes`} />
        <MetricCard label="YOUR CONNECTIONS" value={fmt(connectedMembers)} detail="COVAL members connected to you" />
        <MetricCard label="GITHUB LINKED" value={fmt(members.filter((member) => member.githubLogin).length)} detail="Members sharing public GitHub stats" />
        <MetricCard label="PEOPLE IN DIRECTORY" value={fmt(directoryPeople.length)} detail="COVAL members and public contributors" />
      </section>
      <div className="directory-toolbar">
        <label className="search-field"><Icon name="search" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search COVAL members…" aria-label="Search people" /></label>
        <div className="filter-pills" aria-label="Filter people">
          {["Everyone", "My connections"].map((name) => <button key={name} type="button" className={`filter-pill${filter === name ? " selected" : ""}`} aria-pressed={filter === name} onClick={() => setFilter(name)}>{name}</button>)}
        </div>
      </div>
      {filtered.length ? <div className="people-grid">
        {filtered.map((person) => <article className="person-card" key={person.id}>
          <div className="person-card-head"><button type="button" className="person-card-avatar-button" aria-label={`View ${person.name} profile`} onClick={() => navigate(`profile/${person.id}`)}><Avatar initials={person.initials} name={person.name} color={person.color} size="lg" src={person.avatar} online={person.isActive} /></button><span className={`person-status${person.isActive ? " is-active" : ""}`}><i />{person.isActive ? "Active now" : person.login ? "GitHub" : "COVAL member"}</span></div>
          <div className="person-card-identity"><h2>{person.name}</h2><p className="person-role">{person.login ? `@${person.login}` : "COVAL community member"}</p></div>
          {person.login ? <div className="person-card-stats"><span><b>{person.publicStats?.contributions == null ? "—" : fmt(person.publicStats.contributions)}</b><small>contributions / year</small></span><span><b>{person.publicStats?.pullRequests == null ? "—" : fmt(person.publicStats.pullRequests)}</b><small>PR contributions</small></span><span><b>{person.publicStats?.publicRepositories == null ? "—" : fmt(person.publicStats.publicRepositories)}</b><small>public repositories</small></span></div> : <div className="person-card-stats person-community-note"><span><small>Joined COVAL {person.memberSince ? new Date(person.memberSince).toLocaleDateString() : ""}</small></span></div>}
          <div className="person-card-footer"><span><Icon name="activity" size={14} />{person.location || person.company || (person.login ? "GitHub" : "COVAL")}</span>{person.covalUserId && <button type="button" className={`button person-connect-button${connections.has(connectionKey(person)) ? " button-connected" : " button-quiet"}`} disabled={connectionBusy === connectionKey(person) || person.covalUserId === currentUser?.id} onClick={() => toggleConnection(person)}><Icon name={connections.has(connectionKey(person)) ? "check" : "plus"} size={14} />{connectionBusy === connectionKey(person) ? "Saving…" : connections.has(connectionKey(person)) ? "Connected" : "Connect"}</button>}{person.url && <a className="quiet-icon" href={person.url} target="_blank" rel="noreferrer" aria-label={`Open ${person.name} on GitHub`}><Icon name="arrowUpRight" size={16} /></a>}</div>
        </article>)}
      </div> : <div className="empty-state"><Icon name="users" size={22} /><strong>{directoryPeople.length ? "No people match" : "No COVAL members or GitHub people loaded"}</strong><p>{directoryPeople.length ? "Try another name or GitHub username." : "Signed-in COVAL members and GitHub contributors will appear here."}</p></div>}
      <p className="project-footer-note">Public contribution totals and repository counts appear when GitHub makes them available; unavailable values are left blank instead of showing misleading zeros.</p>
    </>
  );
}
