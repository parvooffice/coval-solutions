"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, AvatarStack, MetricCard } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { fmt } from "../data/dashboard-data";
import { apiRequest } from "../lib/client-api";

export default function OverviewPage({ navigate, notify, onConnectGitHub }) {
  const { dashboard, codeEvaluation, people, projects, activity, metrics, contributions, currentUser } = useDashboardData();
  const [connected, setConnected] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const person = dashboard.primaryProfile
    ? people.find((item) => item.login === dashboard.primaryProfile.login) || { ...dashboard.primaryProfile, id: dashboard.primaryProfile.login, initials: dashboard.primaryProfile.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(), color: "mint", team: "", repositories: [] }
    : null;

  useEffect(() => {
    if (!person?.login) return;
    apiRequest("/api/connections").then(({ connections }) => setConnected(connections.some((item) => item.target_github_login.toLowerCase() === person.login.toLowerCase()))).catch(() => {});
  }, [person?.login]);

  async function toggleConnection() {
    if (!person?.login || connectionBusy) return;
    setConnectionBusy(true);
    try {
      await apiRequest("/api/connections", { method: connected ? "DELETE" : "POST", body: JSON.stringify({ login: person.login }) });
      setConnected(!connected);
      notify(connected ? `Removed ${person.name} from your connections.` : `Connected to ${person.name}.`);
    } catch (error) { notify(error.message); }
    finally { setConnectionBusy(false); }
  }

  const languages = useMemo(() => {
    const counts = {};
    projects.forEach((project) => Object.entries(project.languageBreakdown || {}).forEach(([language, bytes]) => { counts[language] = (counts[language] || 0) + bytes; }));
    const total = Object.values(counts).reduce((sum, bytes) => sum + bytes, 0);
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([language, bytes]) => [language, total ? Math.round((bytes / total) * 100) : 0]);
  }, [projects]);

  const recentWork = activity.slice(0, 5);
  const evaluationTargets = codeEvaluation?.targets || [];
  const profileContributionCount = dashboard.primaryProfile ? contributions.total || 0 : metrics.contributions || 0;

  if (!dashboard.primaryProfile) {
    const accountName = currentUser?.user_metadata?.full_name || currentUser?.user_metadata?.name || currentUser?.email?.split("@")[0] || "there";
    return <>
      <header className="overview-greeting-section">
        <div className="overview-greeting-text"><span className="eyebrow">COVAL COMMUNITY WORKSPACE</span><h1 className="overview-heading">Welcome, {accountName.split(" ")[0]}</h1><p className="overview-subtext">Browse the team directory, explore shared repositories, and connect with people. Your personal GitHub dashboard appears after you connect GitHub.</p></div>
        <div className="overview-greeting-actions"><button type="button" className="button button-primary" onClick={onConnectGitHub}><Icon name="git" size={16} /> Connect GitHub</button><button type="button" className="button button-quiet" onClick={() => navigate("engineering")}><Icon name="users" size={17} /> Explore team</button></div>
      </header>
      <section className="summary-grid" aria-label="Shared workspace overview">
        <MetricCard label="TEAM MEMBERS" value={fmt(metrics.people || 0)} detail="People in the shared GitHub workspace" />
        <MetricCard label="PUBLIC REPOSITORIES" value={fmt(projects.length)} detail="Public repositories and project details" />
        <MetricCard label="ACTIVE TEAMS" value={fmt(metrics.activeTeams || 0)} detail="Teams in the shared workspace" />
      </section>
      <div className="empty-state"><Icon name="activity" size={22} /><strong>Your contribution graph is private to your connected account</strong><p>Connect GitHub to load your repositories, contribution calendar, pull requests, reviews, and streak.</p><button type="button" className="button" onClick={onConnectGitHub}>Connect GitHub</button></div>
      <EvaluationSummary targets={evaluationTargets} navigate={navigate} />
    </>;
  }

  if (!person) return <>
    <div className="empty-state"><Icon name="repo" size={22} /><strong>Connect GitHub to load your workspace</strong><p>Add a GitHub organization or repository list to the server environment, then use Retry connection above.</p><button type="button" className="button" onClick={() => navigate("projects")}>View projects</button></div>
    <EvaluationSummary targets={evaluationTargets} navigate={navigate} />
  </>;

  return (
    <>
      <header className="overview-greeting-section">
        <div className="overview-greeting-text"><span className="eyebrow">GITHUB ENGINEERING INTELLIGENCE</span><h1 className="overview-heading">Welcome, {person.name.split(" ")[0]}</h1><p className="overview-subtext">A live view of repositories and contributions from GitHub.</p></div>
        <div className="overview-greeting-actions"><button type="button" className="button button-quiet" onClick={() => navigate("engineering")}><Icon name="users" size={17} /> Explore team</button></div>
      </header>

      <article className="overview-profile-hero">
        <div className="hero-header">
          <Avatar initials={person.initials} name={person.name} color={person.color} size="xl" src={person.avatar} />
          <div className="hero-identity"><div className="hero-name-row"><h2>{person.name}</h2><a className="team-tag" href={person.url} target="_blank" rel="noreferrer">GitHub profile</a></div>
            <div className="hero-meta"><span><Icon name="briefcase" size={15} /> @{person.login}</span>{person.team && <><i>·</i><span><Icon name="users" size={15} /> {person.team}</span></>}{person.location && <><i>·</i><span><Icon name="activity" size={15} /> {person.location}</span></>}</div>
          </div>
          <div className="hero-actions"><button type="button" className="button button-quiet" onClick={() => navigate(`chat/${person.login}`)}><Icon name="message" size={16} /> Message</button><button type="button" className={`button ${connected ? "button-connected" : "button-quiet"}`} disabled={connectionBusy || person.login === dashboard.primaryProfile?.login} onClick={toggleConnection}><Icon name={connected ? "check" : "plus"} size={17} /> {connectionBusy ? "Saving…" : connected ? "Connected" : "Connect"}</button><button type="button" className="button button-primary" onClick={() => navigate(`profile/${person.id}`)}><Icon name="users" size={16} /> Full profile</button></div>
        </div>
        <p className="hero-bio">{person.bio || "Profile information and engineering activity from GitHub."}</p>
        <div className="hero-footer-bar"><div className="hero-stats"><div><span>GITHUB HANDLE</span><strong>@{person.login}</strong></div><div><span>CONTRIBUTIONS / YEAR</span><strong>{fmt(profileContributionCount)}</strong></div><div><span>MERGED PRS</span><strong>{fmt(metrics.mergedPullRequests || 0)}</strong></div><div><span>ACTIVE STREAK</span><strong>{fmt(metrics.streak || 0)} <small>days</small></strong></div></div>
          <div className="hero-repositories"><span className="eyebrow">CURRENT REPOSITORIES</span><div>{projects.slice(0, 3).map((project) => <button key={project.id} type="button" className="repository-chip" onClick={() => navigate("projects")}><Icon name="repo" size={14} /> {project.name} <Icon name="star" size={13} /> {project.stars}</button>)}</div></div>
        </div>
      </article>

      <section className="overview-metrics-grid" aria-label="GitHub engineering metrics">
        <MetricCard label="CONTRIBUTIONS / YEAR" value={fmt(profileContributionCount)} detail={`Active streak: ${metrics.streak || 0} days · ${metrics.commits || 0} commits`} />
        <MetricCard label="OPEN PULL REQUESTS" value={fmt(metrics.openPullRequests || 0)} detail="Across configured GitHub organization" />
        <MetricCard label="CONNECTED REPOSITORIES" value={fmt(projects.length)} detail="Repository metadata fetched from GitHub" />
        <MetricCard label="CONTRIBUTORS" value={fmt(metrics.collaborators || 0)} detail={`Across ${metrics.teams || 0} GitHub teams`} />
        <MetricCard label="MERGED PULL REQUESTS" value={fmt(metrics.mergedPullRequests || 0)} detail={`${fmt(metrics.mergedThisMonth || 0)} merged this month`} />
      </section>

      <EvaluationSummary targets={evaluationTargets} navigate={navigate} />

      <section className="overview-projects-section"><div className="overview-section-title-bar"><div><span className="eyebrow">GITHUB REPOSITORIES</span><h2 className="overview-section-title">Current projects <span>{projects.length}</span></h2></div><button type="button" className="text-button" onClick={() => navigate("projects")}>EXPLORE ALL {projects.length} REPOSITORIES <Icon name="arrowUpRight" size={14} /></button></div>
        <div className="overview-projects-grid">{projects.slice(0, 3).map((project) => <article className="overview-project-card" key={project.id}><div className="overview-project-heading"><span className="repo-icon"><Icon name="repo" size={17} /></span><span className={`project-status status-${project.status.toLowerCase()}`}><i />{project.status.toUpperCase()}</span></div><button type="button" className="overview-project-name" onClick={() => navigate("projects")}>{project.name}<Icon name="arrowUpRight" size={13} /></button><span className="overview-project-path">{project.repo}</span><p>{project.description || "No description set on GitHub."}</p><div className="project-tags">{project.stack.slice(0, 3).map((tag) => <span className="tech-tag" key={tag}>{tag}</span>)}</div><div className="overview-project-footer"><span>CONTRIBUTORS</span><AvatarStack initials={project.team} limit={3} onPersonSelect={(collaborator) => navigate(`profile/${collaborator.id}`)} /><small>{project.stars} <Icon name="star" size={12} /> · {project.updated}</small></div></article>)}</div>
      </section>

      <div className="overview-lower-grid"><article className="overview-timeline-card"><div className="overview-card-heading"><div><span className="eyebrow">GITHUB ACTIVITY</span><h2 className="overview-card-title">Recent activity</h2></div><button type="button" className="text-button" onClick={() => navigate("activity")}>VIEW ALL <Icon name="arrowUpRight" size={14} /></button></div>
        <div className="overview-timeline-list">{recentWork.map((item) => <div className="overview-timeline-item" key={item.id}><button type="button" className="activity-avatar-button" aria-label={`View ${item.person} profile`} onClick={() => navigate(`profile/${item.login}`)}><Avatar initials={item.initials} name={item.person} color={item.color} size="sm" src={item.avatar} /></button><div className="overview-timeline-content"><div className="overview-timeline-meta"><span>{item.type}</span><strong>{item.person}</strong><small>{item.repo} · {item.time}</small></div><h3>{item.subject}</h3><p>{item.action}</p></div></div>)}{!recentWork.length && <p className="conversation-empty">No organization events are currently available.</p>}</div>
      </article>
      <article className="overview-skills-card"><div className="overview-card-heading"><div><span className="eyebrow">LANGUAGE BREAKDOWN</span><h2 className="overview-card-title">Repository technology</h2></div><button type="button" className="text-button" onClick={() => navigate("projects")}>VIEW REPOSITORIES <Icon name="arrowUpRight" size={14} /></button></div><section className="skills-section-block"><span className="skills-section-label">LANGUAGES BY REPOSITORY BYTES</span>{languages.map(([language, value]) => <div className="language-meter" key={language}><span>{language}</span><i><b style={{ width: `${value}%` }} /></i><strong>{value}%</strong></div>)}{!languages.length && <p className="conversation-empty">GitHub language data will appear when repositories are connected.</p>}</section><section className="skills-section-block"><span className="skills-section-label">CONTRIBUTION CALENDAR</span><p>{fmt(contributions.total || 0)} contributions in the last year across {fmt(projects.length)} repositories.</p><button type="button" className="text-button" onClick={() => navigate("activity")}>OPEN ACTIVITY <Icon name="arrowUpRight" size={14} /></button></section></article></div>
    </>
  );
}

function EvaluationSummary({ targets, navigate }) {
  return <section className="overview-evaluation-section surface-card" aria-label="Code evaluation scores">
    <div className="overview-section-title-bar">
      <div><span className="eyebrow">REPOSITORY ANALYZERS</span><h2 className="overview-section-title">Code evaluation</h2></div>
      <button type="button" className="text-button" onClick={() => navigate("code-evaluation")}>OPEN EVALUATION <Icon name="arrowUpRight" size={14} /></button>
    </div>
    {targets.length ? <>
      {targets.slice(0, 5).map((target) => <div className="overview-evaluation-project" key={`${target.input}-${target.name}`}>
        <p className="overview-evaluation-target"><strong>{target.name}</strong> · {target.source === "github" ? "GitHub repository" : "local workspace"}</p>
        <div className="overview-evaluation-grid">{(target.evaluations || []).map((evaluation) => <article className="overview-evaluation-card" key={evaluation.id}>
          <span>{evaluation.label}</span>
          <strong>{evaluation.score == null ? "—" : `${evaluation.score}`}<small>/100</small></strong>
          <small>{evaluation.status === "complete" ? evaluation.grade || "Analyzer score" : evaluation.error || "No score available"}</small>
        </article>)}</div>
      </div>)}
      {targets.length > 5 && <p className="conversation-empty">Showing 5 of {targets.length} repositories. Open Code Evaluation to view every score.</p>}
    </> : <p className="conversation-empty">Run the documentation, modularity, security, and error-handling analyzers to show scores here.</p>}
  </section>;
}
