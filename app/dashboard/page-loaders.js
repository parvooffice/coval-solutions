// Each section loads on first visit (and in the background once the dashboard is idle),
// so the first screen downloads only what it shows.
export const PAGE_LOADERS = {
  engineering: () => import("../components/people-page"),
  projects: () => import("../components/projects-page"),
  network: () => import("../components/network-page"),
  teams: () => import("../components/teams-page"),
  billing: () => import("../components/billing-page"),
  feed: () => import("../components/feed-page"),
  activity: () => import("../components/activity-page"),
  chat: () => import("../components/messages-page"),
  profile: () => import("../components/profile-page"),
  "code-evaluation": () => import("../components/code-evaluation-page"),
};

// Start downloading a section before it's opened (hovering its link, or when idle).
export function prefetchRoute(route) {
  PAGE_LOADERS[String(route).split("/")[0]]?.().catch(() => {});
}
