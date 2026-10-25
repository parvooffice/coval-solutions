"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, MetricCard } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";
import { fmt } from "../data/dashboard-data";

const profileTabs = ["Overview", "Projects", "Activity"];

function ContributionGrid({ days }) {
  if (!days?.length) return <p className="profile-muted">Contribution calendar is available for the configured GitHub account when GraphQL access is enabled.</p>;
  return <div className="contribution-grid" role="img" aria-label="GitHub contribution activity over the last year">{days.map((day) => <i key={day.date} className={`contribution-cell level-${day.level}`} title={`${day.date}: ${day.count} contributions`} />)}</div>;
}

export default function ProfilePage({ personId, navigate, notify }) {
  const { people, projects, activity, currentUser, dashboard } = useDashboardData();
  const [profileResult, setProfileResult] = useState({ id: "", profile: null, error: "" });
  const [activeTab, setActiveTab] = useState("Overview");
  const [connected, setConnected] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareId, setCompareId] = useState("");
  const directoryPerson = people.find((candidate) => candidate.id.toLowerCase() === String(personId).toLowerCase() || candidate.login.toLowerCase() === String(personId).toLowerCase());

  useEffect(() => {
    let active = true;
    if (!personId) return () => { active = false; };
    apiRequest(`/api/profile?login=${encodeURIComponent(personId)}`).then((profile) => { if (active) setProfileResult({ id: personId, profile, error: "" }); }).catch((error) => { if (active) setProfileResult({ id: personId, profile: null, error: error.message }); });
    return () => { active = false; };
  }, [personId]);

  useEffect(() => {
    if (!directoryPerson?.login) return;
    apiRequest("/api/connections").then(({ connections }) => setConnected(connections.some((item) => item.target_github_login.toLowerCase() === directoryPerson.login.toLowerCase()))).catch(() => {});
  }, [directoryPerson?.login]);

  useEffect(() => {
    if (!compareOpen) return undefined;
    const close = (event) => { if (event.key === "Escape") setCompareOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [compareOpen]);

  const profile = profileResult.id === personId ? profileResult.profile : null;
  const profileError = profileResult.id === personId ? profileResult.error : "";
  const person = useMemo(() => profile ? {
    ...directoryPerson,
    ...profile,
    team: profile.team || directoryPerson?.team || "",
    teams: profile.teams?.length ? profile.teams : directoryPerson?.teams || [],
    repositories: directoryPerson?.repositories || profile.repositories || [],
  } : directoryPerson, [directoryPerson, profile]);
  const memberProjects = useMemo(() => person ? projects.filter((project) => project.team.includes(person.login) || project.team.includes(person.id)) : [], [person, projects]);
  const collaborators = useMemo(() => {
    const logins = new Set(memberProjects.flatMap((project) => project.team).filter((login) => login.toLowerCase() !== String(person?.login || "").toLowerCase()));
    return [...logins].map((login) => people.find((candidate) => candidate.login === login)).filter(Boolean).slice(0, 8);
  }, [memberProjects, people, person?.login]);
  const personActivity = activity.filter((item) => item.login?.toLowerCase() === String(person?.login || "").toLowerCase());
  const comparePerson = people.find((candidate) => candidate.login === compareId && candidate.login !== person?.login);
  const languages = useMemo(() => {
    const counts = {};
    memberProjects.forEach((project) => Object.entries(project.languageBreakdown || {}).forEach(([language, bytes]) => { counts[language] = (counts[language] || 0) + bytes; }));
    const total = Object.values(counts).reduce((sum, bytes) => sum + bytes, 0);
    return Object.entries(counts).sort((left, right) => right[1] - left[1]).map(([language, bytes]) => [language, total ? Math.round((bytes / total) * 100) : 0]);
  }, [memberProjects]);

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

  if (!person && !profileError) return <div className="empty-state profile-not-found"><Icon name="users" size={22} /><strong>Loading GitHub profile…</strong></div>;
  if (!person) return <section className="empty-state profile-not-found"><Icon name="users" size={22} /><strong>GitHub profile could not be loaded</strong><p>{profileError}</p><button type="button" className="button button-quiet" onClick={() => navigate("engineering")}>Browse people</button></section>;

  const contributionData = profile?.contributions || directoryPerson?.contributionDetails || (dashboard.primaryProfile?.login === person.login ? dashboard.contributions : null);
  const contributionTotal = contributionData?.total || person.commits || 0;
  const personPRs = contributionData?.pullRequests || person.prs || 0;
  const githubIdentity = currentUser?.identities?.find((identity) => identity.provider === "github");
  const currentLogin = dashboard.primaryProfile?.login || githubIdentity?.identity_data?.user_name || githubIdentity?.identity_data?.login || "";

  return <>
    <div className="developer-profile">
      <div className="profile-breadcrumb"><button type="button" className="text-button" onClick={() => navigate("engineering")}><Icon name="users" size={14} /> ALL ENGINEERS</button><span>/</span><span>{person.name}</span></div>
      <header className="developer-profile-hero surface-card">
        <div className="profile-cover"><span>GITHUB <i>·</i> {person.team || "PUBLIC PROFILE"}</span><span className="profile-cover-status"><i /> GITHUB PROFILE <b>{person.location || ""}</b></span></div>
        <div className="developer-profile-heading"><Avatar initials={person.initials} name={person.name} color={person.color || "mint"} size="xl" src={person.avatar} /><div className="developer-profile-identity"><span className="eyebrow">GITHUB DEVELOPER</span><div className="developer-profile-name-row"><h1>{person.name}</h1></div><p className="profile-handle">@{person.login} <span>·</span> {person.role || "GitHub account"}</p></div><div className="developer-profile-actions"><button type="button" className="button button-quiet" onClick={() => navigate(`chat/${person.login}`)}><Icon name="message" size={16} /> Message</button><button type="button" className={`button ${connected ? "button-connected" : "button-primary"}`} disabled={connectionBusy || person.login === currentLogin} onClick={toggleConnection}><Icon name={connected ? "check" : "plus"} size={16} /> {connectionBusy ? "Saving…" : connected ? "Connected" : "Connect"}</button><a className="button button-quiet" href={person.url} target="_blank" rel="noreferrer">GitHub <Icon name="arrowUpRight" size={15} /></a></div></div>
        <p className="developer-profile-bio">{person.bio || "No public GitHub bio."}</p>
        <div className="developer-profile-meta">{person.location && <span><Icon name="activity" size={15} /> {person.location}</span>}{person.company && <span><Icon name="briefcase" size={15} /> {person.company}</span>}{person.team && <span><Icon name="users" size={15} /> {person.team}</span>}<span><Icon name="repo" size={15} /> {person.publicRepositories ?? memberProjects.length} public repositories</span></div>
        {memberProjects.length > 0 && <div className="developer-profile-repos"><span className="eyebrow">CONTRIBUTING TO</span><div>{memberProjects.slice(0, 3).map((project) => <button type="button" key={project.id} className="repository-chip" onClick={() => navigate("projects")}><Icon name="repo" size={14} /> {project.name}</button>)}</div></div>}
      </header>

      <section className="summary-grid profile-summary-grid" aria-label="GitHub profile metrics"><MetricCard label="CONTRIBUTIONS / YEAR" value={fmt(contributionTotal)} detail="GitHub contribution calendar" /><MetricCard label="PULL REQUESTS / YEAR" value={fmt(personPRs)} detail="GitHub contribution total" /><MetricCard label="PULL REQUEST REVIEWS" value={fmt(contributionData?.reviews || person.reviews || 0)} detail="Review contributions" /><MetricCard label="FOLLOWERS" value={fmt(person.followers || 0)} detail="Public GitHub profile" /></section>

      <nav className="profile-tabs" aria-label="GitHub profile sections">{profileTabs.map((tab) => <button type="button" key={tab} className={`profile-tab${activeTab === tab ? " selected" : ""}`} aria-current={activeTab === tab ? "page" : undefined} onClick={() => setActiveTab(tab)}>{tab}{tab === "Projects" && <small>{memberProjects.length}</small>}{tab === "Activity" && <small>{personActivity.length}</small>}</button>)}<button type="button" className="profile-tab" onClick={() => { setCompareId(""); setCompareOpen(true); }}>Compare</button></nav>

      {activeTab === "Overview" && <>
        <section className="profile-activity-card surface-card"><div className="profile-section-heading"><div><span className="eyebrow">GITHUB CONTRIBUTIONS</span><h2>Code, in motion.</h2></div><span className="profile-period">LAST 12 MONTHS</span></div><div className="profile-activity-stats"><div><strong>{fmt(contributionTotal)}</strong><span>CONTRIBUTIONS</span></div><div><strong>{fmt(contributionData?.current || 0)} days</strong><span>ACTIVE STREAK</span></div><div><strong>{fmt(personPRs)}</strong><span>PULL REQUESTS</span></div><div><strong>{fmt(memberProjects.reduce((total, project) => total + project.stars, 0))}</strong><span>PROJECT STARS</span></div></div><ContributionGrid days={contributionData?.days} /><div className="contribution-legend"><span>LESS</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`contribution-cell level-${level}`} />)}<span>MORE</span></div></section>
        <div className="profile-content-columns"><section className="profile-panel surface-card"><div className="profile-section-heading"><div><span className="eyebrow">LANGUAGES</span><h2>Repository technology.</h2></div></div>{languages.length ? languages.map(([language, value]) => <div className="profile-skill" key={language}><span>{language}</span><strong>{value}%</strong><i><b style={{ width: `${value}%` }} /></i></div>) : <p className="profile-muted">No language data for this profile&apos;s connected repositories.</p>}</section>
          <section className="profile-panel surface-card"><div className="profile-section-heading"><div><span className="eyebrow">PUBLIC PROFILE</span><h2>GitHub at a glance.</h2></div></div><div className="profile-signal-list"><div><span>Followers</span><strong>{fmt(person.followers || 0)}</strong></div><div><span>Public repositories</span><strong>{fmt(person.publicRepositories ?? memberProjects.length)}</strong></div><div><span>Organization teams</span><strong>{fmt(person.teams?.length || 0)}</strong></div><div><span>Contributed repositories</span><strong>{fmt(memberProjects.length)}</strong></div></div></section></div>
        <section className="profile-collaborators surface-card"><div className="profile-section-heading"><div><span className="eyebrow">COLLABORATORS</span><h2>People with shared repositories.</h2></div></div>{collaborators.length ? <div className="profile-collaborator-list">{collaborators.map((collaborator) => <button type="button" className="profile-collaborator" key={collaborator.id} onClick={() => navigate(`profile/${collaborator.id}`)}><Avatar initials={collaborator.initials} name={collaborator.name} color={collaborator.color} size="md" src={collaborator.avatar} /><span><strong>{collaborator.name}</strong><small>@{collaborator.login}</small></span><Icon name="arrowUpRight" size={15} /></button>)}</div> : <p className="profile-muted">No shared repositories found.</p>}</section>
      </>}

      {activeTab === "Projects" && <section className="profile-projects-panel"><div className="profile-section-heading"><div><span className="eyebrow">GITHUB REPOSITORIES</span><h2>Repositories with contributions.</h2></div><span className="profile-period">{memberProjects.length} REPOSITORIES</span></div><div className="profile-project-grid">{memberProjects.map((project) => <article className="profile-project-card surface-card" key={project.id}><div className="profile-project-top"><span className="repo-icon"><Icon name="repo" size={17} /></span><span className={`project-status status-${project.status.toLowerCase()}`}><i />{project.status.toUpperCase()}</span></div><h3>{project.name}</h3><span className="profile-project-path">{project.repo}</span><p>{project.description || "No description set on GitHub."}</p><div className="project-tags">{project.stack.slice(0, 4).map((tag) => <span className="tech-tag" key={tag}>{tag}</span>)}</div><div className="profile-project-foot"><span><Icon name="star" size={13} /> {project.stars}</span><span>{project.team.length} contributors</span><a className="text-button" href={project.url} target="_blank" rel="noreferrer">OPEN <Icon name="arrowUpRight" size={13} /></a></div></article>)}</div>{!memberProjects.length && <p className="profile-muted">No repository contributors match this GitHub profile.</p>}</section>}

      {activeTab === "Activity" && <section className="profile-panel surface-card profile-feed-panel"><div className="profile-section-heading"><div><span className="eyebrow">GITHUB ORGANIZATION EVENTS</span><h2>Recent activity.</h2></div><button type="button" className="text-button" onClick={() => navigate("activity")}>FULL TIMELINE <Icon name="arrowUpRight" size={13} /></button></div><div className="profile-feed">{personActivity.map((item) => <a className="profile-feed-item" key={item.id} href={item.url} target="_blank" rel="noreferrer"><Avatar initials={person.initials} name={person.name} color={person.color || "mint"} size="sm" src={person.avatar} /><div><span className="eyebrow">{item.type} · {item.time}</span><h3>{item.subject}</h3><p>{item.repo} · {item.action}</p></div></a>)}</div>{!personActivity.length && <p className="profile-muted">No recent organization events were returned for this account.</p>}</section>}
    </div>

    {compareOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompareOpen(false); }}><section className="project-dialog profile-compare-dialog" role="dialog" aria-modal="true" aria-label="Compare GitHub profiles"><button type="button" className="icon-button dialog-close" aria-label="Close profile comparison" onClick={() => setCompareOpen(false)}><Icon name="x" size={17} /></button><span className="eyebrow">PROFILE COMPARISON</span><h2>Compare GitHub activity.</h2><p>Compare repository contribution counts and public profile data currently available from GitHub.</p><label className="search-field"><span>Compare with</span><select value={compareId} onChange={(event) => setCompareId(event.target.value)}><option value="">Choose a teammate</option>{people.filter((candidate) => candidate.login !== person.login).map((candidate) => <option key={candidate.login} value={candidate.login}>{candidate.name} (@{candidate.login})</option>)}</select></label>{comparePerson && <div className="profile-compare-results"><div><Avatar initials={person.initials} name={person.name} color={person.color || "mint"} size="md" /><strong>{person.name}</strong><span>{fmt(person.commits || 0)} repo commits · {fmt(person.prs || 0)} PRs · {person.repositories.length} repos</span></div><div><Avatar initials={comparePerson.initials} name={comparePerson.name} color={comparePerson.color} size="md" /><strong>{comparePerson.name}</strong><span>{fmt(comparePerson.commits || 0)} repo commits · {fmt(comparePerson.prs || 0)} PRs · {comparePerson.repositories.length} repos</span></div></div>}<small>GitHub API visibility and token permissions affect available metrics.</small></section></div>}
  </>;
}
