// COVAL for Windows exposes `window.covalDesktop` (see desktop/preload.js). In a normal
// browser it is missing, and everything here does nothing.

export function getDesktop() {
  return typeof window !== "undefined" && window.covalDesktop ? window.covalDesktop : null;
}

export function notificationText(notification) {
  if (notification.text) return notification.text; // messages and Feed posts come with their own text
  switch (notification.kind) {
    case "team_invite": return `invited you to join ${notification.team?.name || "a team"}`;
    case "post_interest": return "is interested in your post";
    case "interest_accepted": return "accepted your interest";
    default: return "connected with you";
  }
}

export function notificationRoute(notification) {
  if (notification.kind === "message") return "chat";
  if (notification.kind?.startsWith("feed_")) return "feed";
  if (notification.kind === "team_invite") return "teams";
  if (notification.kind === "post_interest" || notification.kind === "interest_accepted") return "feed";
  return `profile/member-${notification.actor.covalUserId}`;
}

const SEEN_KEY = "coval.desktop.notified";

function readSeen() {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_KEY) || "null");
    return Array.isArray(value) ? new Set(value) : null;
  } catch {
    return null;
  }
}

function writeSeen(ids) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    /* storage unavailable: worst case a notification shows twice */
  }
}

// Shows a Windows notification for each unread notification not shown before.
// The first time it runs it only remembers what's there, so old notifications don't pop up.
export function announceNotifications(notifications, settings = {}) {
  const desktop = getDesktop();
  if (!desktop) return;
  const unread = notifications.filter((notification) => !notification.readAt);
  desktop.setUnread(unread.length);
  const seen = readSeen();
  if (seen && settings.desktop_popups !== false) {
    for (const notification of unread) {
      if (seen.has(notification.id)) continue;
      desktop.notify({ title: notification.actor.name, body: notificationText(notification), route: notificationRoute(notification) });
    }
  }
  writeSeen(new Set([...(seen || []), ...notifications.map((notification) => notification.id)]));
}

// Windows pop-up when a scoring run finishes (Settings → Notifications → Scores).
export function announceScores(targets, settings = {}) {
  const desktop = getDesktop();
  if (!desktop || settings.scores === false || settings.desktop_popups === false || !targets?.length) return;
  const scored = targets.map((target) => {
    const scores = (target.evaluations || []).map((item) => item.score).filter((score) => typeof score === "number");
    const overall = scores.length ? Math.round((scores.reduce((sum, value) => sum + value, 0) / scores.length) * 10) / 10 : null;
    return `${target.name || target.url}${overall == null ? "" : ` ${overall}`}`;
  });
  desktop.notify({ title: targets.length === 1 ? "Scores are ready" : `${targets.length} repositories scored`, body: scored.join(" · ").slice(0, 280), route: "code-evaluation" });
}

// Turns a local scan (desktop/lib/agents.js format) into the shape the report components use.
export function localScanTarget(scan) {
  const folderName = scan.workspace.split(/[\\/]/).filter(Boolean).pop() || scan.workspace;
  return {
    url: "",
    name: folderName,
    folder: scan.workspace,
    scannedAt: scan.scannedAt,
    evaluations: scan.results.map((result) => ({
      id: result.id,
      label: result.label,
      score: result.score,
      grade: result.grade,
      status: result.error ? "failed" : "complete",
      summary: result.summary,
      error: result.error,
      fixes: result.findings.slice(0, 8).map(({ title, location, detail }) => ({ title, location, detail })),
      breakdown: Object.fromEntries(result.categories.map((category) => [category.key, { label: category.label, score: category.score }])),
    })),
  };
}
