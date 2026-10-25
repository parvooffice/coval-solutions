"use client";

import { useMemo, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, MetricCard, PageHeading } from "./ui";
import { useDashboardData } from "../dashboard/dashboard-data-provider";
import { fmt } from "../data/dashboard-data";

function activityIcon(type) {
  if (type.includes("REVIEW")) return "check";
  if (type.includes("PULL REQUEST")) return "git";
  if (type.includes("PUSH")) return "send";
  if (type.includes("ISSUE")) return "plus";
  return "activity";
}

export default function ActivityPage({ navigate }) {
  const { activity, pullRequests, people, metrics, contributions } = useDashboardData();
  const [period, setPeriod] = useState("Last 12 months");
  const [kind, setKind] = useState("All activity");
  const days = contributions.days || [];
  const visibleDays = period === "Last 12 months" ? days : days.slice(-30);
  const types = ["All activity", ...new Set(activity.map((item) => item.type))];
  const filteredActivity = useMemo(() => kind === "All activity" ? activity : activity.filter((item) => item.type === kind), [activity, kind]);
  const merged = metrics.mergedPullRequests || 0;

  return (
    <>
      <PageHeading eyebrow="GITHUB SIGNAL / ACTIVITY" title="A steady pulse of progress." description="Contribution calendar, pull requests, and organization events fetched from GitHub." action={<button type="button" className="button button-quiet" onClick={() => setPeriod((value) => value === "Last 12 months" ? "Last 30 days" : "Last 12 months")}><Icon name="calendar" size={16} /> {period} <Icon name="chevronDown" size={15} /></button>} />
      <section className="summary-grid activity-metrics" aria-label="GitHub activity metrics">
        <MetricCard label="CONTRIBUTIONS" value={fmt(metrics.contributions || 0)} detail="Configured GitHub account, past year" />
        <MetricCard label="MERGED PULL REQUESTS" value={fmt(merged)} detail={`${fmt(metrics.mergedThisMonth || 0)} merged this month`} />
        <MetricCard label="PULL REQUEST REVIEWS" value={fmt(metrics.reviews || 0)} detail="Account contribution total or recent org review events" />
        <MetricCard label="ACTIVE STREAK" value={fmt(metrics.streak || 0)} unit="days" detail={`Best streak: ${fmt(metrics.bestStreak || 0)} days`} badge={metrics.streak ? "ACTIVE" : undefined} />
      </section>
      <section className="contribution-card surface-card">
        <div className="section-title-row"><div><span className="eyebrow">GITHUB CONTRIBUTION CALENDAR</span><h2>Consistency over time</h2></div><span className="contribution-total"><strong>{fmt(contributions.total || 0)}</strong> contributions</span></div>
        {visibleDays.length ? <div className="contribution-chart-scroll"><div className={`contribution-chart${period === "Last 30 days" ? " contribution-chart-month" : ""}`}>
          <div className="weekday-labels"><span>Mon</span><span>Wed</span><span>Fri</span></div>
          <div className={`contribution-grid${period === "Last 30 days" ? " contribution-grid-month" : ""}`} role="img" aria-label={`GitHub contribution activity for ${period.toLowerCase()}`}>{visibleDays.map((day) => <span key={day.date} className={`contribution-cell level-${day.level}`} title={`${day.date}: ${day.count} contribution${day.count === 1 ? "" : "s"}`} />)}{period === "Last 30 days" && Array.from({ length: Math.max(0, 35 - visibleDays.length) }, (_, index) => <span key={`empty-${index}`} className="contribution-cell contribution-cell-empty" aria-hidden="true" />)}</div>
          <div className="month-labels"><span>{visibleDays[0]?.date}</span><span>{visibleDays.at(-1)?.date}</span></div>
        </div></div> : <div className="empty-state"><Icon name="activity" size={22} /><strong>No contribution calendar available</strong><p>Set GITHUB_USERNAME and a token with GitHub GraphQL access to load this account&apos;s contribution streak.</p></div>}
        <div className="contribution-legend"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`contribution-cell level-${level}`} />)}<span>More</span><small>Counts are from GitHub&apos;s contribution calendar.</small></div>
      </section>
      <section className="activity-feed-section"><div className="section-title-row"><div><span className="eyebrow">ORGANIZATION ACTIVITY</span><h2>Recent work</h2></div><div className="filter-pills">{types.slice(0, 6).map((type) => <button key={type} type="button" className={`filter-pill${kind === type ? " selected" : ""}`} aria-pressed={kind === type} onClick={() => setKind(type)}>{type}</button>)}</div></div><div className="activity-feed surface-card">
        {filteredActivity.map((item) => {
          const person = people.find((candidate) => candidate.login === item.login);
          return <article className="activity-feed-row" key={item.id}><span className="activity-timeline"><Icon name={activityIcon(item.type)} size={16} /></span><button type="button" className="activity-avatar-button" aria-label={`View ${item.person} profile`} onClick={() => navigate(`profile/${item.login}`)}><Avatar initials={item.initials} name={item.person} color={item.color} size="sm" src={item.avatar} /></button><div className="activity-feed-copy"><p><strong>{person?.name || item.person}</strong> {item.action} <b>{item.subject}</b></p><span><Icon name="repo" size={13} /> {item.repository || item.repo} <i>·</i> {item.type}</span></div><time>{item.time}</time><a className="quiet-icon" href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.subject} on GitHub`}><Icon name="arrowUpRight" size={16} /></a></article>;
        })}
        {!filteredActivity.length && <div className="conversation-empty">No GitHub organization events were returned for this filter.</div>}
      </div></section>
      <section className="activity-feed-section"><div className="section-title-row"><div><span className="eyebrow">PULL REQUESTS</span><h2>Recent requests</h2></div><span className="live-count"><i /> {pullRequests.length} LOADED</span></div><div className="activity-feed surface-card">
        {pullRequests.slice(0, 30).map((pull) => {const person = people.find((candidate) => candidate.login === pull.author);return <article className="activity-feed-row" key={pull.id}><span className="activity-timeline"><Icon name="git" size={16} /></span><button type="button" className="activity-avatar-button" onClick={() => navigate(`profile/${pull.author}`)} aria-label={`View ${pull.author} profile`}><Avatar initials={person?.initials || pull.author.slice(0, 2).toUpperCase()} name={person?.name || pull.author} color={person?.color || "mint"} size="sm" src={person?.avatar || pull.avatar} /></button><div className="activity-feed-copy"><p><strong>{person?.name || pull.author}</strong> · #{pull.number} {pull.title}</p><span><Icon name="repo" size={13} /> {pull.repo} <i>·</i> {pull.state.toUpperCase()}</span></div><time>{pull.updatedAt ? new Date(pull.updatedAt).toLocaleDateString() : ""}</time><a className="quiet-icon" href={pull.url} target="_blank" rel="noreferrer" aria-label={`Open pull request ${pull.number} on GitHub`}><Icon name="arrowUpRight" size={16} /></a></article>;})}
        {!pullRequests.length && <div className="conversation-empty">No pull requests returned. Connect repositories with read access to load them.</div>}
      </div></section>
    </>
  );
}
