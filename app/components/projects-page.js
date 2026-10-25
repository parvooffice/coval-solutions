"use client";

import { useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, AvatarStack, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";

export default function ProjectsPage({ navigate }) {
  const { people, projects } = useDashboardData();
  const [query, setQuery] = useState("");
  const [stack, setStack] = useState("All");
  const [selectedProject, setSelectedProject] = useState(null);
  const [showAllFilters, setShowAllFilters] = useState(false);
  const allStacks = [...new Set(projects.flatMap((project) => project.stack || []))].sort();
  const filters = ["All", ...allStacks];
  const visibleFilters = showAllFilters ? filters : filters.slice(0, 13);
  const filtered = useMemo(() => projects.filter((project) => {
    const matchesQuery = `${project.name} ${project.repo} ${project.description} ${(project.stack || []).join(" ")}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (stack === "All" || project.stack?.includes(stack));
  }), [projects, query, stack]);

  return (
    <>
      <PageHeading eyebrow={`GITHUB REPOSITORIES / ${projects.length} REPOS`} title="Projects with people attached." description="Repository details, languages, stars, contributors, and update times come directly from GitHub." action={<div className="projects-heading-actions"><button type="button" className="button button-quiet" onClick={() => navigate("code-evaluation")}><Icon name="code" size={15} /> Evaluate repositories</button><span className="live-count"><i /> {projects.filter((project) => project.status === "Active").length} ACTIVE</span></div>} />
      <div className="project-toolbar">
        <label className="search-field project-search"><Icon name="search" size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repositories…" aria-label="Search projects" /></label>
        <div className="filter-pills project-filters" aria-label="Filter repositories by technology">
          {visibleFilters.map((filter) => <button key={filter} type="button" className={`filter-pill${stack === filter ? " selected" : ""}`} aria-pressed={stack === filter} onClick={() => setStack(filter)}>{filter}</button>)}
          {filters.length > visibleFilters.length && <button type="button" className="filter-pill" onClick={() => setShowAllFilters(true)}>+{filters.length - visibleFilters.length} more</button>}
        </div>
      </div>
      {filtered.length ? <div className="projects-grid">
        {filtered.map((project) => (
          <article key={project.id} className="project-card">
            <div className="project-card-top"><span className="repo-icon"><Icon name="repo" size={18} /></span><span className={`project-status status-${project.status.toLowerCase()}`}><i />{project.status.toUpperCase()}</span></div>
            <button type="button" className="project-path" onClick={() => setSelectedProject(project)}>{project.repo}<Icon name="arrowUpRight" size={15} /></button>
            <p className="project-description">{project.description || "No description set on GitHub."}</p>
            <div className="project-tags">{project.stack.slice(0, 3).map((tag) => <span key={tag} className="tech-tag">{tag}</span>)}</div>
            <div className="project-card-bottom"><span><Icon name="star" size={15} /> {project.stars}</span><span><Icon name="clock" size={15} /> {project.updated}</span><AvatarStack initials={project.team} /></div>
            <div className="project-hover">
              <p>{project.description || "No description set on GitHub."}</p>
              <div className="project-tags">{project.stack.map((tag) => <span key={tag} className="tech-tag">{tag}</span>)}</div>
              <div className="hover-contributors"><span>CONTRIBUTORS</span><div>{project.team.slice(0, 5).map((login) => {const person = people.find((candidate) => candidate.login === login);return <button key={login} type="button" aria-label={`View ${person?.name || login}`} title={person?.name || login} onClick={() => navigate(`profile/${login}`)}><Avatar initials={person?.initials || login.slice(0, 2).toUpperCase()} name={person?.name || login} color={person?.color || "mint"} size="sm" src={person?.avatar} /></button>;})}</div><small>{project.team.length} GitHub contributors · click to explore</small></div>
            </div>
          </article>
        ))}
      </div> : <div className="empty-state"><Icon name="repo" size={22} /><strong>{projects.length ? "No repositories found" : "No GitHub repositories loaded"}</strong><p>{projects.length ? "Adjust the search or technology filter." : "Connect an organization or list repositories in the server environment to populate this page."}</p></div>}
      <p className="project-footer-note">Stars, languages, contributors, and update dates are fetched from GitHub <i>·</i> {filtered.length} / {projects.length} repositories</p>
      {selectedProject && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedProject(null); }} role="presentation"><section className="project-dialog" role="dialog" aria-modal="true" aria-label={`${selectedProject.name} repository details`}><button type="button" className="icon-button dialog-close" aria-label="Close repository details" onClick={() => setSelectedProject(null)}><Icon name="x" /></button><span className={`project-status status-${selectedProject.status.toLowerCase()}`}><i />{selectedProject.status.toUpperCase()}</span><span className="eyebrow">GITHUB REPOSITORY</span><h2>{selectedProject.repo}</h2><p>{selectedProject.description || "No description set on GitHub."}</p><div className="project-dialog-meta"><span><Icon name="star" size={16} /> {selectedProject.stars} stars</span><span><Icon name="clock" size={16} /> UPDATED {selectedProject.updated.toUpperCase()}</span><a href={selectedProject.url} target="_blank" rel="noreferrer">Open on GitHub <Icon name="arrowUpRight" size={14} /></a></div><span className="eyebrow">TECHNOLOGY STACK</span><div className="project-tags">{selectedProject.stack.map((tag) => <span key={tag} className="tech-tag">{tag}</span>)}</div><span className="eyebrow">TOP CONTRIBUTORS / CONTRIBUTIONS</span>{selectedProject.contributors.slice(0, 8).map((contributor) => {const person = people.find((candidate) => candidate.login === contributor.login);return <button type="button" className="contributor-line" key={contributor.login} onClick={() => { setSelectedProject(null); navigate(`profile/${contributor.login}`); }}><Avatar initials={person?.initials || contributor.login.slice(0, 2).toUpperCase()} name={person?.name || contributor.login} color={person?.color || "mint"} size="sm" src={person?.avatar || contributor.avatar} /><span>{person?.name || contributor.login}</span><strong>{contributor.contributions} commits</strong></button>;})}</section></div>}
    </>
  );
}
