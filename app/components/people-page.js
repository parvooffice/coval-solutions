"use client";

import { useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, MetricCard, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { fmt } from "../data/dashboard-data";

export default function PeoplePage({ navigate }) {
  const { people, teams, metrics, pullRequests } = useDashboardData();
  const [query, setQuery] = useState("");
  const [team, setTeam] = useState("All people");
  const filtered = useMemo(() => people.filter((person) => {
    const matchesQuery = `${person.name} ${person.login} ${person.role} ${person.team} ${person.bio}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (team === "All people" || person.teams?.includes(team));
  }), [people, query, team]);

  return (
    <>
      <PageHeading eyebrow={`GITHUB DIRECTORY / ${people.length} PEOPLE`} title="Engineering, connected." description="People and team membership are read from the configured GitHub organization. Profile fields link to their public GitHub account." action={<button type="button" className="button button-quiet" onClick={() => navigate("network")}><Icon name="network" size={17} /> Explore network</button>} />
      <section className="summary-grid" aria-label="Engineering team summary">
        <MetricCard label="ORG CONTRIBUTORS" value={fmt(metrics.people || 0)} detail="GitHub contributors and members" />
        <MetricCard label="REPOSITORY CONTRIBUTIONS" value={fmt(metrics.repositoryCommits || 0)} detail="GitHub contributor counts summed across repositories" />
        <MetricCard label="MERGED PULL REQUESTS" value={fmt(metrics.mergedPullRequests || 0)} detail="Across the configured organization" />
        <MetricCard label="ACTIVE TEAMS" value={fmt(metrics.activeTeams || 0)} detail={`${fmt(metrics.teams || 0)} GitHub teams configured`} />
      </section>
      <div className="directory-toolbar">
        <label className="search-field"><Icon name="search" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search GitHub people…" aria-label="Search people" /></label>
        <div className="filter-pills" aria-label="Filter people by team">
          {["All people", ...teams.map((item) => item.name)].map((name) => <button key={name} type="button" className={`filter-pill${team === name ? " selected" : ""}`} aria-pressed={team === name} onClick={() => setTeam(name)}>{name}</button>)}
        </div>
      </div>
      {filtered.length ? <div className="people-grid">
        {filtered.map((person) => <article className="person-card" key={person.id}>
          <div className="person-card-head"><button type="button" className="person-card-avatar-button" aria-label={`View ${person.name} profile`} onClick={() => navigate(`profile/${person.id}`)}><Avatar initials={person.initials} name={person.name} color={person.color} size="lg" src={person.avatar} /></button><span className="person-status"><i className="dot-online" />GitHub</span></div>
          <div className="person-card-identity"><h2>{person.name}</h2><p className="person-role">@{person.login}</p>{person.teams?.map((name) => <span className="team-tag" key={name}>{name}</span>)}</div>
          <div className="person-card-stats"><span><b>{fmt(person.commits || 0)}</b><small>repo commits</small></span><span><b>{fmt(person.prs || 0)}</b><small>merged PRs seen</small></span><span><b>{person.repositories.length}</b><small>repositories</small></span></div>
          <div className="person-card-footer"><span><Icon name="activity" size={14} />{person.location || person.company || "GitHub"}</span><a className="quiet-icon" href={person.url} target="_blank" rel="noreferrer" aria-label={`Open ${person.name} on GitHub`}><Icon name="arrowUpRight" size={16} /></a></div>
        </article>)}
      </div> : <div className="empty-state"><Icon name="users" size={22} /><strong>{people.length ? "No teammates match" : "No GitHub people loaded"}</strong><p>{people.length ? "Try another name or team." : "Organization members and repository contributors will appear after GitHub is connected."}</p></div>}
      <p className="project-footer-note">Merged pull request counts on individual cards reflect pull requests indexed in the recent repository window ({pullRequests.length} PRs loaded).</p>
    </>
  );
}
