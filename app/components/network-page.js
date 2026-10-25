"use client";

import { useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";

function position(index, total) {
  const angle = (Math.PI * 2 * index) / Math.max(total, 1) - Math.PI / 2;
  return [50 + Math.cos(angle) * (total < 4 ? 24 : 38), 50 + Math.sin(angle) * (total < 4 ? 23 : 37)];
}

export default function NetworkPage({ navigate }) {
  const { people, teams, projects } = useDashboardData();
  const [selectedTeam, setSelectedTeam] = useState("All teams");
  const visiblePeople = selectedTeam === "All teams" ? people : people.filter((person) => person.teams?.includes(selectedTeam));
  const points = useMemo(() => visiblePeople.map((_, index) => position(index, visiblePeople.length)), [visiblePeople]);
  const edges = useMemo(() => {
    const matches = [];
    for (let left = 0; left < visiblePeople.length; left += 1) {
      for (let right = left + 1; right < visiblePeople.length; right += 1) {
        const shared = visiblePeople[left].repositories.filter((repo) => visiblePeople[right].repositories.includes(repo));
        if (shared.length) matches.push({ left, right, strength: shared.length });
      }
    }
    return matches.slice(0, 100);
  }, [visiblePeople]);

  return (
    <>
      <PageHeading eyebrow="GITHUB GRAPH / COLLABORATION" title="How the team connects." description="Connections are inferred from contributors who have worked in the same GitHub repositories. Team membership comes from GitHub organization teams." action={<span className="live-count"><i /> {visiblePeople.length} PEOPLE</span>} />
      <div className="network-toolbar surface-card"><div><span className="eyebrow">VIEWING</span><strong>{selectedTeam}</strong></div><div className="filter-pills"><button type="button" className={`filter-pill${selectedTeam === "All teams" ? " selected" : ""}`} onClick={() => setSelectedTeam("All teams")}>All teams</button>{teams.map((team) => <button key={team.id} type="button" className={`filter-pill${selectedTeam === team.name ? " selected" : ""}`} onClick={() => setSelectedTeam(team.name)}>{team.name}</button>)}</div></div>
      <section className="network-canvas surface-card" aria-label="GitHub collaboration network">
        <div className="network-canvas-header"><div><span className="eyebrow">REPOSITORY OVERLAP</span><h2>People connected by shared work</h2></div><span className="network-legend"><i /> Shared GitHub repositories</span></div>
        {visiblePeople.length ? <>
          <svg className="network-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {edges.map(({ left, right, strength }) => <line key={`${left}-${right}`} x1={points[left][0]} y1={points[left][1]} x2={points[right][0]} y2={points[right][1]} strokeWidth={Math.min(0.8 + strength * 0.2, 2)} />)}
          </svg>
          <div className="network-nodes">
            {visiblePeople.map((person, index) => {
              const point = points[index];
              return <button key={person.id} type="button" className="network-node" style={{ left: `${point[0]}%`, top: `${point[1]}%` }} onClick={() => navigate(`profile/${person.id}`)} title={`${person.name} · ${person.repositories.length} repositories`}><Avatar initials={person.initials} name={person.name} color={person.color} size="md" src={person.avatar} /><span>{person.name.split(" ")[0]}</span></button>;
            })}
          </div>
        </> : <div className="empty-state"><Icon name="network" size={22} /><strong>No collaboration graph yet</strong><p>Connect GitHub organization repositories to map shared contributors.</p></div>}
      </section>
      <section className="org-section"><div className="section-title-row"><div><span className="eyebrow">GITHUB ORGANIZATION TEAMS</span><h2>Connected squads</h2></div><button type="button" className="text-button" onClick={() => navigate("engineering")}>Explore people <Icon name="arrowRight" size={14} /></button></div><div className="team-grid">
        {teams.map((team) => <article key={team.id} className="team-card surface-card"><div className="team-card-top"><span className={`team-icon team-${team.color}`}><Icon name="users" size={18} /></span><span className="team-count">{team.count} members</span></div><h3>{team.name}</h3><p>{team.description || `${team.count} GitHub organization members`}</p><div className="team-members">{team.members.slice(0, 8).map((person) => <button type="button" key={person.id} title={person.name} onClick={() => navigate(`profile/${person.id}`)}><Avatar initials={person.initials} name={person.name} color={person.color} size="sm" src={person.avatar} /></button>)}</div></article>)}
        {!teams.length && <div className="empty-state"><Icon name="users" size={22} /><strong>No GitHub teams loaded</strong><p>Set GITHUB_ORG and grant the GitHub token read:org permission to show squads.</p></div>}
      </div></section>
      <p className="project-footer-note">Graph lines represent people with contributions in at least one shared repository. {projects.length} repositories are included.</p>
    </>
  );
}
