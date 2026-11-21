import { useCallback, useEffect, useState } from "react";
import Icon from "./dashboard-icon";
import { Avatar, PageHeading } from "./ui";
import { formatScore, gradeFor } from "./evaluation-report";
import { apiRequest } from "../lib/client-api";
import { isGuest, requestSignIn } from "../lib/guest";

const KINDS = [
  { id: "showcase", label: "Score showcase", short: "Showcase", icon: "star", placeholder: "e.g. Took my API from 58 to 84 in two weeks" },
  { id: "job", label: "Job opening", short: "Hiring", icon: "briefcase", placeholder: "e.g. Hiring a backend engineer (Node, Postgres)" },
  { id: "team", label: "Team formation", short: "Team up", icon: "users", placeholder: "e.g. Looking for 2 people for a hackathon project" },
];
const kindMeta = (id) => KINDS.find((kind) => kind.id === id) || KINDS[0];
const initials = (name = "COVAL") => name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();

function timeAgo(value) {
  const seconds = Math.max(1, (Date.now() - new Date(value).getTime()) / 1000);
  for (const [limit, unit, size] of [[60, "s", 1], [3600, "m", 60], [86400, "h", 3600], [604800, "d", 86400]]) {
    if (seconds < limit) return `${Math.floor(seconds / size)}${unit} ago`;
  }
  return new Date(value).toLocaleDateString();
}

const SAMPLE_POSTS = [
  { id: "s1", kind: "showcase", title: "Flask scores 82.7 across ten review agents", body: "Ran COVAL on Flask to see how a mature project looks. Strong tests and maintainability; documentation is the weak spot.", createdAt: new Date(Date.now() - 3_600_000).toISOString(), interestCount: 12, author: { name: "Ava Patel", login: "avap", headline: "Platform engineer" }, score: { token: "sample", name: "pallets/flask", overall: 82.7, best: [{ label: "Maintainability", score: 96.9 }, { label: "Test coverage", score: 93.4 }], weakest: { label: "Documentation", score: 57.4 } }, queue: [] },
  { id: "s2", kind: "job", title: "Hiring: backend engineer (Node.js + Postgres), Bengaluru / remote", body: "Small product team. Share a COVAL report of a project you're proud of when you show interest.", location: "Bengaluru · Remote", createdAt: new Date(Date.now() - 7_200_000).toISOString(), interestCount: 31, author: { name: "Northwind Labs", login: "northwind", headline: "Hiring" }, queue: [] },
  { id: "s3", kind: "team", title: "Looking for 2 teammates for a 48-hour hackathon", body: "Building an accessibility checker. Need one frontend and one ML person.", createdAt: new Date(Date.now() - 86_400_000).toISOString(), interestCount: 5, author: { name: "Liam Chen", login: "liamc", headline: "Frontend lead" }, queue: [] },
];

function ScoreCard({ score }) {
  if (!score) return null;
  const grade = gradeFor(score.overall);
  return <a className="feed-score" href={`/report/${score.token}`} target="_blank" rel="noreferrer">
    <span className={`feed-score-ring eval-grade-${grade || "none"}`}><strong>{formatScore(score.overall)}</strong><small>{grade}</small></span>
    <span className="feed-score-text">
      <strong>{score.name}</strong>
      <small>{score.best?.map((item) => `${item.label} ${formatScore(item.score)}`).join(" · ")}{score.weakest ? ` · weakest: ${score.weakest.label} ${formatScore(score.weakest.score)}` : ""}</small>
      <em>View full report <Icon name="arrowUpRight" size={12} /></em>
    </span>
  </a>;
}

export default function FeedPage({ navigate, notify }) {
  const guest = isGuest();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [composer, setComposer] = useState({ open: false, kind: "showcase", title: "", body: "", shareToken: "", teamId: "", location: "" });
  const [noteFor, setNoteFor] = useState("");
  const [note, setNote] = useState("");
  const [openQueue, setOpenQueue] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await apiRequest(`/api/feed?composer=1${filter ? `&kind=${filter}` : ""}`);
      setData(result);
      setError("");
    } catch (cause) {
      setError(cause.message || "Could not load the feed.");
      setData({ posts: [], signedIn: false, myShares: [], myTeams: [] });
    }
  }, [filter]);
  useEffect(() => { load(); }, [load]);

  const usingSamples = data && !data.posts.length && (guest || import.meta.env.DEV);
  const posts = usingSamples ? SAMPLE_POSTS.filter((post) => !filter || post.kind === filter) : data?.posts || [];
  const canAct = data?.signedIn && !usingSamples;

  async function act(payload, success, key) {
    if (!canAct) { requestSignIn("Sign in to post and connect with people on the feed."); return false; }
    setBusy(key || payload.action);
    setError("");
    try {
      await apiRequest("/api/feed", { method: "POST", body: JSON.stringify(payload) });
      if (success) notify?.(success);
      await load();
      return true;
    } catch (cause) {
      setError(cause.message || "That did not go through.");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function publish(event) {
    event.preventDefault();
    const ok = await act({ action: "create", ...composer }, "Posted to the feed.", "create");
    if (ok) setComposer({ open: false, kind: "showcase", title: "", body: "", shareToken: "", teamId: "", location: "" });
  }

  const meta = kindMeta(composer.kind);
  return <>
    <PageHeading
      eyebrow="COVAL / FEED"
      title="Feed"
      description="Show your code health, post job openings, and find teammates. Tap Interested to join someone's queue."
      action={<button type="button" className="button button-primary" onClick={() => (canAct ? setComposer((current) => ({ ...current, open: !current.open })) : requestSignIn("Sign in to share your score or post an opening."))}><Icon name="plus" size={15} /> New post</button>}
    />
    {error && <div className="backend-status-banner" role="alert"><div><strong>Feed needs attention.</strong><p>{error}</p></div><button type="button" className="button" onClick={() => setError("")}>Dismiss</button></div>}
    {usingSamples && <div className="nt-sample-banner" role="status"><Icon name="info" size={15} /><span><strong>Sample posts.</strong> {guest ? "Sign in to post and respond." : "The feed is empty, so these examples show how it looks."}</span>{guest && <button type="button" className="button button-quiet" onClick={() => requestSignIn()}>Sign in</button>}</div>}

    {composer.open && <form className="feed-composer surface-card" onSubmit={publish}>
      <div className="nt-segmented" role="radiogroup" aria-label="Post type">
        {KINDS.map((kind) => <button key={kind.id} type="button" role="radio" aria-checked={composer.kind === kind.id} className={composer.kind === kind.id ? "is-active" : ""} onClick={() => setComposer((current) => ({ ...current, kind: kind.id }))}><Icon name={kind.icon} size={13} /> {kind.label}</button>)}
      </div>
      <input value={composer.title} onChange={(event) => setComposer((current) => ({ ...current, title: event.target.value }))} maxLength={120} placeholder={meta.placeholder} aria-label="Post title" required />
      <textarea value={composer.body} onChange={(event) => setComposer((current) => ({ ...current, body: event.target.value }))} maxLength={2000} rows={4} placeholder={composer.kind === "job" ? "Role, stack, experience, how to apply…" : composer.kind === "team" ? "What you're building and who you need…" : "What you improved, what you learned…"} aria-label="Post text" />
      <div className="feed-composer-row">
        {composer.kind === "showcase" && (data?.myShares?.length
          ? <label>Report<select value={composer.shareToken} onChange={(event) => setComposer((current) => ({ ...current, shareToken: event.target.value }))} required><option value="">Choose a shared report</option>{data.myShares.map((share) => <option key={share.token} value={share.token}>{share.name}</option>)}</select></label>
          : <p className="team-muted">Share a repository from <button type="button" className="text-button" onClick={() => navigate("code-evaluation")}>Code Evaluation</button> first; its verified score appears on your post.</p>)}
        {composer.kind === "job" && <label>Location<input value={composer.location} onChange={(event) => setComposer((current) => ({ ...current, location: event.target.value }))} maxLength={80} placeholder="City · Remote" /></label>}
        {composer.kind === "team" && data?.myTeams?.length > 0 && <label>Invite accepted people to<select value={composer.teamId} onChange={(event) => setComposer((current) => ({ ...current, teamId: event.target.value }))}><option value="">No team (just connect)</option>{data.myTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>}
      </div>
      <div className="feed-composer-actions"><button type="button" className="button button-quiet" onClick={() => setComposer((current) => ({ ...current, open: false }))}>Cancel</button><button type="submit" className="button button-primary" disabled={busy === "create"}>{busy === "create" ? "Posting…" : "Post"}</button></div>
    </form>}

    <div className="nt-segmented feed-filters" role="tablist" aria-label="Filter posts">
      {[{ id: "", short: "All" }, ...KINDS].map((kind) => <button key={kind.id || "all"} type="button" role="tab" aria-selected={filter === kind.id} className={filter === kind.id ? "is-active" : ""} onClick={() => setFilter(kind.id)}>{kind.short}</button>)}
    </div>

    {!data && <div className="empty-state"><Icon name="activity" size={22} /><strong>Loading the feed…</strong></div>}
    {data && !posts.length && <div className="empty-state surface-card"><Icon name="message" size={22} /><strong>No posts yet</strong><p>Be the first: share your score, post an opening, or find teammates.</p></div>}

    <div className="feed-list">
      {posts.map((post) => {
        const kind = kindMeta(post.kind);
        const pending = post.queue.filter((item) => item.status === "pending").length;
        return <article key={post.id} className={`feed-post surface-card ${post.closed ? "is-closed" : ""}`}>
          <header className="feed-post-head">
            <button type="button" className="feed-author" onClick={() => post.author.login && !usingSamples && navigate(`profile/${post.author.login}`)}>
              <Avatar initials={initials(post.author.name)} name={post.author.name} size="md" src={post.author.avatar} />
              <span><strong>{post.author.name}</strong><small>{[post.author.headline, timeAgo(post.createdAt)].filter(Boolean).join(" · ")}</small></span>
            </button>
            <span className={`feed-kind is-${post.kind}`}><Icon name={kind.icon} size={12} /> {kind.short}</span>
          </header>
          <h3>{post.title}</h3>
          {post.location && <p className="feed-location"><Icon name="network" size={12} /> {post.location}</p>}
          {post.body && <p className="feed-body">{post.body}</p>}
          <ScoreCard score={post.score} />
          <footer className="feed-post-foot">
            <span className="team-muted">{post.interestCount} interested{post.closed ? " · closed" : ""}{post.teamLinked ? " · accepting invites to a team" : ""}</span>
            <div className="feed-post-actions">
              {post.isMine ? <>
                <button type="button" className="button button-quiet" onClick={() => setOpenQueue(openQueue === post.id ? "" : post.id)}>Queue{pending ? ` (${pending} new)` : ""}</button>
                <button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={() => act({ action: "close", postId: post.id, closed: !post.closed }, post.closed ? "Post reopened." : "Post closed.")}>{post.closed ? "Reopen" : "Close"}</button>
                <button type="button" className="button button-quiet team-danger" disabled={Boolean(busy)} onClick={() => window.confirm("Delete this post?") && act({ action: "delete", postId: post.id }, "Post deleted.")}>Delete</button>
              </> : post.myInterest ? <>
                <span className={`feed-status is-${post.myInterest.status}`}>{post.myInterest.status === "accepted" ? "Accepted ✓" : post.myInterest.status === "declined" ? "Not selected" : "In queue"}</span>
                {post.myInterest.status === "pending" && <button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={() => act({ action: "withdraw", postId: post.id }, "Removed from the queue.")}>Withdraw</button>}
              </> : !post.closed && <button type="button" className="button button-primary" onClick={() => { if (!canAct) { requestSignIn("Sign in to show interest and join the queue."); return; } setNoteFor(noteFor === post.id ? "" : post.id); setNote(""); }}><Icon name="star" size={14} /> Interested</button>}
            </div>
          </footer>
          {noteFor === post.id && <form className="feed-note" onSubmit={async (event) => { event.preventDefault(); if (await act({ action: "interest", postId: post.id, note }, "You're in the queue.")) setNoteFor(""); }}>
            <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={post.kind === "job" ? "Optional: a line about you, or a link to your COVAL report" : "Optional note for the author"} aria-label="Note to the author" />
            <button type="submit" className="button button-primary" disabled={Boolean(busy)}>Join queue</button>
          </form>}
          {post.isMine && openQueue === post.id && <ul className="feed-queue">
            {!post.queue.length && <li className="team-muted">No one has shown interest yet.</li>}
            {post.queue.map((item) => <li key={item.userId}>
              <Avatar initials={initials(item.name)} name={item.name} size="sm" src={item.avatar} />
              <span><strong>{item.name}</strong><small>{item.note || item.headline || (item.login ? `@${item.login}` : "")}</small></span>
              {item.status === "pending" ? <>
                <button type="button" className="button button-primary" disabled={Boolean(busy)} onClick={() => act({ action: "respond", postId: post.id, userId: item.userId, accept: true }, post.teamLinked ? `Accepted ${item.name} and sent a team invite.` : `Accepted ${item.name}.`)}>Accept</button>
                <button type="button" className="button button-quiet" disabled={Boolean(busy)} onClick={() => act({ action: "respond", postId: post.id, userId: item.userId, accept: false }, "Declined.")}>Decline</button>
              </> : <span className={`feed-status is-${item.status}`}>{item.status === "accepted" ? "Accepted" : "Declined"}</span>}
              {item.login && <button type="button" className="button button-quiet" onClick={() => navigate(`chat/${item.login}`)}><Icon name="message" size={13} /> Message</button>}
            </li>)}
          </ul>}
        </article>;
      })}
    </div>
  </>;
}
