"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, MetricCard } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { apiRequest } from "../lib/client-api";
import ProfileEditorDialog from "./profile-editor-dialog";
import { fmt } from "../data/dashboard-data";

const profileTabs = ["Overview", "Projects", "Activity"];

function projectKey(project) {
  return project.repo || project.url || project.id;
}

function ContributionGrid({ days }) {
  if (!days?.length) return <p className="profile-muted">A full contribution calendar is private to its owner. Public repository commit counts and repositories are shown above.</p>;
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
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const directoryPerson = people.find((candidate) => candidate.id.toLowerCase() === String(personId).toLowerCase() || candidate.login.toLowerCase() === String(personId).toLowerCase());

  useEffect(() => {
    let active = true;
    if (!personId) return () => { active = false; };
    const profileQuery = personId.startsWith("member-")
      ? `memberId=${encodeURIComponent(personId.slice("member-".length))}`
      : `login=${encodeURIComponent(personId)}`;
    apiRequest(`/api/profile?${profileQuery}`).then((profile) => { if (active) setProfileResult({ id: personId, profile, error: "" }); }).catch((error) => { if (active) setProfileResult({ id: personId, profile: null, error: error.message }); });
    return () => { active = false; };
  }, [personId]);

  useEffect(() => {
    if (!compareOpen) return undefined;
    const close = (event) => { if (event.key === "Escape") setCompareOpen(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [compareOpen]);

  const profile = profileResult.id === personId ? profileResult.profile : null;
  const profileError = profileResult.id === personId ? profileResult.error : "";
  const person = useMemo(() => {
    if (!profile) return directoryPerson;
    const directoryRepositories = (directoryPerson?.repositories || []).map((repository) => typeof repository === "string"
      ? projects.find((project) => project.id === repository || project.repo === repository)
      : repository).filter(Boolean);
    const repositoriesById = new Map();
    [...directoryRepositories, ...(Array.isArray(profile.repositories) ? profile.repositories : [])].forEach((repository) => {
      repositoriesById.set(repository.id || repository.repo, repository);
    });
    return {
      ...directoryPerson,
      ...profile,
      repositories: [...repositoriesById.values()],
    };
  }, [directoryPerson, profile, projects]);
  useEffect(() => {
    const login = directoryPerson?.login || person?.login || "";
    const userId = directoryPerson?.covalUserId || person?.covalUserId || "";
    if (!login && !userId) return;
    apiRequest("/api/connections").then(({ connections = [], memberConnections = [] }) => {
      setConnected(Boolean((login && connections.some((item) => item.target_github_login.toLowerCase() === login.toLowerCase()))
        || (userId && memberConnections.some((item) => item.target_user_id === userId))));
    }).catch(() => {});
  }, [directoryPerson?.covalUserId, directoryPerson?.login, person?.covalUserId, person?.login]);
  const memberProjects = useMemo(() => {
    if (!person) return [];
    const sharedProjects = projects.filter((project) => (person.login && project.team.includes(person.login)) || project.team.includes(person.id));
    const publicRepositories = (person.repositories || []).filter((repository) => repository && typeof repository === "object");
    const allProjects = [...sharedProjects, ...publicRepositories];
    const unique = [...new Map(allProjects.map((project) => [projectKey(project), project])).values()];
    if (profile?.profileVisibility?.repositories === false) return [];
    const featured = profile?.featuredRepositories;
    return Array.isArray(featured) ? unique.filter((project) => [projectKey(project), project.id, project.repo, project.url].some((key) => key && featured.includes(key))) : unique;
  }, [person, profile, projects]);
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
    if ((!person?.login && !person?.covalUserId) || connectionBusy) return;
    setConnectionBusy(true);
    try {
      const target = person.covalUserId ? { userId: person.covalUserId } : { login: person.login };
      await apiRequest("/api/connections", { method: connected ? "DELETE" : "POST", body: JSON.stringify(target) });
      setConnected(!connected);
      notify(connected ? `Disconnected from ${person.name}.` : `Connected with ${person.name}. Choose whether they appear in your Network tree.`);
    } catch (error) { notify(error.message); }
    finally { setConnectionBusy(false); }
  }

  if (!person && !profileError) return <div className="empty-state profile-not-found"><Icon name="users" size={22} /><strong>Loading COVAL profile…</strong></div>;
  if (!person) return <section className="empty-state profile-not-found"><Icon name="users" size={22} /><strong>Profile could not be loaded</strong><p>{profileError}</p><button type="button" className="button button-quiet" onClick={() => navigate("engineering")}>Browse people</button></section>;

  const contributionData = profile?.contributions || directoryPerson?.contributionDetails || (dashboard.primaryProfile?.login === person.login ? dashboard.contributions : null);
  const contributionTotal = contributionData?.total ?? person.publicRepoCommits ?? person.commits ?? 0;
  const personPRs = contributionData?.pullRequests || person.prs || 0;
  const githubIdentity = currentUser?.identities?.find((identity) => identity.provider === "github");
  const currentLogin = dashboard.primaryProfile?.login || githubIdentity?.identity_data?.user_name || githubIdentity?.identity_data?.login || "";
  const isOwnMember = Boolean(person.covalUserId && person.covalUserId === currentUser?.id);
  const hasGitHubProfile = Boolean(person.login);
  const visibility = profile?.profileVisibility || { contributions: true, repositories: true, activity: true, evaluations: true };
  const codeEvaluations = profile?.codeEvaluations || [];

  async function saveProfile(values, banner = {}) {
    const result = await apiRequest("/api/profile", { method: "PUT", body: JSON.stringify(values) });
    let bannerUrl = currentBannerUrl();
    if (banner.bannerFile) {
      const formData = new FormData();
      formData.set("banner", banner.bannerFile);
      const uploaded = await apiRequest("/api/profile/banner", { method: "POST", body: formData });
      bannerUrl = uploaded.bannerUrl;
    } else if (banner.removeBanner) {
      await apiRequest("/api/profile/banner", { method: "DELETE" });
      bannerUrl = "";
    }
    setProfileResult((current) => ({ ...current, profile: { ...current.profile, ...values, ...result.profile, bannerUrl, name: values.profileName || current.profile?.name, bio: values.bio, location: values.location, company: values.company, role: values.headline || "COVAL member" } }));
    notify?.("Your public profile has been updated.");
  }

  function currentBannerUrl() {
    return profile?.bannerUrl || "";
  }

  return <>
    <div className="developer-profile">
      <div className="profile-breadcrumb"><button type="button" className="text-button" onClick={() => navigate("engineering")}><Icon name="users" size={14} /> PEOPLE</button><span>/</span><span>{person.name}</span></div>
      <header className="developer-profile-hero surface-card">
        <div className={`profile-cover${profile?.bannerUrl ? " has-banner" : ""}`} style={profile?.bannerUrl ? { backgroundImage: `linear-gradient(90deg, rgb(9 9 11 / 45%), rgb(9 9 11 / 8%)), url("${profile.bannerUrl}")` } : undefined}><span>COVAL <i>·</i> COMMUNITY PROFILE</span><span className={`profile-cover-status${person.isActive ? " is-online" : ""}`}><i /> {person.isActive ? "ACTIVE NOW" : "MEMBER"} <b>{person.location || ""}</b></span></div>
        <div className="developer-profile-heading"><Avatar initials={person.initials} name={person.name} color={person.color || "mint"} size="xl" src={person.avatar} online={person.isActive} /><div className="developer-profile-identity"><span className="eyebrow">{person.headline || "COVAL MEMBER"}</span><div className="developer-profile-name-row"><h1>{person.name}</h1></div><p className="profile-handle">{person.login ? `@${person.login}` : "COVAL member"}</p></div><div className="developer-profile-actions">{isOwnMember && <button type="button" className="button button-primary" onClick={() => setEditProfileOpen(true)}><Icon name="settings" size={15} /> Edit profile</button>}{hasGitHubProfile && !isOwnMember && <button type="button" className="button button-quiet" onClick={() => navigate(`chat/${person.login}`)}><Icon name="message" size={16} /> Message</button>}{person.covalUserId && !isOwnMember && <button type="button" className={`button ${connected ? "button-connected" : "button-primary"}`} disabled={connectionBusy || Boolean(person.login && person.login === currentLogin)} onClick={toggleConnection}><Icon name={connected ? "check" : "plus"} size={16} /> {connectionBusy ? "Saving…" : connected ? "Connected" : "Connect"}</button>}{person.url && <a className="button button-quiet" href={person.url} target="_blank" rel="noreferrer"><Icon name="arrowUpRight" size={15} /> External profile</a>}</div></div>
        {(person.bio || person.location || person.company) && <p className="developer-profile-bio">{person.bio}</p>}
        <div className="developer-profile-meta">{person.location && <span><Icon name="activity" size={15} /> {person.location}</span>}{person.company && <span><Icon name="briefcase" size={15} /> {person.company}</span>}{visibility.repositories && <span><Icon name="repo" size={15} /> {memberProjects.length} featured {memberProjects.length === 1 ? "project" : "projects"}</span>}</div>
        {visibility.repositories && memberProjects.length > 0 && <div className="developer-profile-repos"><span className="eyebrow">FEATURED WORK</span><div>{memberProjects.slice(0, 3).map((project) => <button type="button" key={project.id || project.repo} className="repository-chip" onClick={() => setActiveTab("Projects")}><Icon name="repo" size={14} /> {project.name}</button>)}</div></div>}
      </header>

      {hasGitHubProfile && visibility.contributions && <section className="summary-grid profile-summary-grid" aria-label="Profile contribution metrics"><MetricCard label={contributionData ? "CONTRIBUTIONS / YEAR" : "REPOSITORY COMMITS"} value={fmt(contributionTotal)} detail={contributionData ? "Across the past year" : `Across ${person.publicRepoCommitRepositories || 0} recently updated repositories`} /><MetricCard label="PULL REQUESTS / YEAR" value={fmt(personPRs)} detail="Contribution total" /><MetricCard label="PULL REQUEST REVIEWS" value={fmt(contributionData?.reviews || person.reviews || 0)} detail="Reviews contributed" /><MetricCard label="FOLLOWERS" value={fmt(person.followers || 0)} detail="Community reach" /></section>}

      <nav className="profile-tabs" aria-label="Profile sections">{profileTabs.filter((tab) => tab === "Overview" || tab === "Projects" && visibility.repositories || tab === "Activity" && visibility.activity).map((tab) => <button type="button" key={tab} className={`profile-tab${activeTab === tab ? " selected" : ""}`} aria-current={activeTab === tab ? "page" : undefined} onClick={() => setActiveTab(tab)}>{tab}{tab === "Projects" && <small>{memberProjects.length}</small>}{tab === "Activity" && <small>{personActivity.length}</small>}</button>)}{hasGitHubProfile && <button type="button" className="profile-tab" onClick={() => { setCompareId(""); setCompareOpen(true); }}>Compare</button>}</nav>

      {!hasGitHubProfile && activeTab === "Overview" && <section className="profile-panel surface-card"><div className="profile-section-heading"><div><span className="eyebrow">COVAL PROFILE</span><h2>Part of the community.</h2></div></div><div className="profile-signal-list"><div><span>Member since</span><strong>{person.createdAt ? new Date(person.createdAt).toLocaleDateString() : "Recently"}</strong></div><div><span>Presence</span><strong>{person.isActive ? "Active now" : "Member"}</strong></div></div></section>}

      {activeTab === "Overview" && <>
        {hasGitHubProfile && visibility.contributions && <section className="profile-activity-card surface-card"><div className="profile-section-heading"><div><span className="eyebrow">CONTRIBUTIONS</span><h2>Code, in motion.</h2></div><span className="profile-period">LAST 12 MONTHS</span></div><div className="profile-activity-stats"><div><strong>{fmt(contributionTotal)}</strong><span>CONTRIBUTIONS</span></div><div><strong>{fmt(contributionData?.current || 0)} days</strong><span>ACTIVE STREAK</span></div><div><strong>{fmt(personPRs)}</strong><span>PULL REQUESTS</span></div><div><strong>{fmt(memberProjects.reduce((total, project) => total + project.stars, 0))}</strong><span>PROJECT STARS</span></div></div><ContributionGrid days={contributionData?.days} /><div className="contribution-legend"><span>LESS</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`contribution-cell level-${level}`} />)}<span>MORE</span></div></section>}
        {hasGitHubProfile && visibility.repositories && <div className="profile-content-columns"><section className="profile-panel surface-card"><div className="profile-section-heading"><div><span className="eyebrow">LANGUAGES</span><h2>Repository technology.</h2></div></div>{languages.length ? languages.map(([language, value]) => <div className="profile-skill" key={language}><span>{language}</span><strong>{value}%</strong><i><b style={{ width: `${value}%` }} /></i></div>) : <p className="profile-muted">No language data for this profile&apos;s featured repositories.</p>}</section>
          <section className="profile-panel surface-card"><div className="profile-section-heading"><div><span className="eyebrow">COMMUNITY PROFILE</span><h2>Work and connections.</h2></div></div><div className="profile-signal-list"><div><span>Followers</span><strong>{fmt(person.followers || 0)}</strong></div><div><span>Visible projects</span><strong>{fmt(memberProjects.length)}</strong></div><div><span>COVAL account</span><strong>{person.covalUserId ? "Member" : "Community"}</strong></div></div></section></div>}
        {visibility.evaluations && <section className="profile-panel surface-card profile-evaluations-panel"><div className="profile-section-heading"><div><span className="eyebrow">CODE EVALUATION</span><h2>Repository health scores.</h2></div>{isOwnMember && <button type="button" className="text-button" onClick={() => navigate("code-evaluation")}>MANAGE RESULTS <Icon name="arrowUpRight" size={13} /></button>}</div>{codeEvaluations.length ? <div className="profile-evaluation-list">{codeEvaluations.map((target) => <article className="profile-evaluation-card" key={`${target.url || target.name}-${target.generatedAt}`}><div><strong>{target.name}</strong><small>{target.generatedAt ? `Evaluated ${new Date(target.generatedAt).toLocaleDateString()}` : "Shared evaluation"}</small></div><div className="profile-evaluation-scores">{(target.evaluations || []).map((evaluation) => <span key={evaluation.id}><b>{evaluation.score == null ? "—" : fmt(evaluation.score)}</b><small>{evaluation.label}</small></span>)}</div></article>)}</div> : <p className="profile-muted">{isOwnMember ? "Share your repository scores from Code Evaluation to feature them here." : "No shared code evaluation results yet."}</p>}</section>}
        {visibility.repositories && <section className="profile-collaborators surface-card"><div className="profile-section-heading"><div><span className="eyebrow">COLLABORATORS</span><h2>People building with you.</h2></div></div>{collaborators.length ? <div className="profile-collaborator-list">{collaborators.map((collaborator) => <button type="button" className="profile-collaborator" key={collaborator.id} onClick={() => navigate(`profile/${collaborator.id}`)}><Avatar initials={collaborator.initials} name={collaborator.name} color={collaborator.color} size="md" src={collaborator.avatar} /><span><strong>{collaborator.name}</strong><small>@{collaborator.login}</small></span><Icon name="arrowUpRight" size={15} /></button>)}</div> : <p className="profile-muted">No shared repositories found.</p>}</section>}
      </>}

      {activeTab === "Projects" && visibility.repositories && <section className="profile-projects-panel"><div className="profile-section-heading"><div><span className="eyebrow">FEATURED REPOSITORIES</span><h2>Projects and contributions.</h2></div><span className="profile-period">{memberProjects.length} PROJECTS</span></div><div className="profile-project-grid">{memberProjects.map((project) => <article className="profile-project-card surface-card" key={project.id || project.repo || project.url}><div className="profile-project-top"><span className="repo-icon"><Icon name="repo" size={17} /></span><span className={`project-status status-${String(project.status || "active").toLowerCase()}`}><i />{String(project.status || "active").toUpperCase()}</span></div><h3>{project.name}</h3><span className="profile-project-path">{project.repo}</span><p>{project.description || "A project shared with the COVAL community."}</p><div className="project-tags">{(project.stack || []).slice(0, 4).map((tag) => <span className="tech-tag" key={tag}>{tag}</span>)}</div><div className="profile-project-foot"><span><Icon name="star" size={13} /> {project.stars || 0}</span><span>{project.team?.length || 0} contributors</span>{project.url && <a className="text-button" href={project.url} target="_blank" rel="noreferrer">OPEN <Icon name="arrowUpRight" size={13} /></a>}</div></article>)}</div>{!memberProjects.length && <p className="profile-muted">No featured projects yet.</p>}</section>}

      {activeTab === "Activity" && visibility.activity && <section className="profile-panel surface-card profile-feed-panel"><div className="profile-section-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>Work shared with the community.</h2></div></div><div className="profile-feed">{personActivity.map((item) => <a className="profile-feed-item" key={item.id} href={item.url} target="_blank" rel="noreferrer"><Avatar initials={person.initials} name={person.name} color={person.color || "mint"} size="sm" src={person.avatar} /><div><span className="eyebrow">{item.type} · {item.time}</span><h3>{item.subject}</h3><p>{item.repo} · {item.action}</p></div></a>)}</div>{!personActivity.length && <p className="profile-muted">No recent activity to show.</p>}</section>}
    </div>

    {editProfileOpen && <ProfileEditorDialog profile={profile || person} repositories={memberProjects} onClose={() => setEditProfileOpen(false)} onSave={saveProfile} />}
    {compareOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCompareOpen(false); }}><section className="project-dialog profile-compare-dialog" role="dialog" aria-modal="true" aria-label="Compare member profiles"><button type="button" className="icon-button dialog-close" aria-label="Close profile comparison" onClick={() => setCompareOpen(false)}><Icon name="x" size={17} /></button><span className="eyebrow">PROFILE COMPARISON</span><h2>Compare community activity.</h2><p>Compare repository contributions and the details members choose to share.</p><label className="search-field"><span>Compare with</span><select value={compareId} onChange={(event) => setCompareId(event.target.value)}><option value="">Choose a teammate</option>{people.filter((candidate) => candidate.login !== person.login).map((candidate) => <option key={candidate.login} value={candidate.login}>{candidate.name} (@{candidate.login})</option>)}</select></label>{comparePerson && <div className="profile-compare-results"><div><Avatar initials={person.initials} name={person.name} color={person.color || "mint"} size="md" /><strong>{person.name}</strong><span>{fmt(person.commits || 0)} repo commits · {fmt(person.prs || 0)} PRs · {person.repositories.length} repos</span></div><div><Avatar initials={comparePerson.initials} name={comparePerson.name} color={comparePerson.color} size="md" src={comparePerson.avatar} /><strong>{comparePerson.name}</strong><span>{fmt(comparePerson.commits || 0)} repo commits · {fmt(comparePerson.prs || 0)} PRs · {comparePerson.repositories.length} repos</span></div></div>}<small>Only information shared on your profiles is shown.</small></section></div>}
  </>;
}
