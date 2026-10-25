const API_BASE = "https://api.github.com";
const GRAPHQL_URL = "https://api.github.com/graphql";
const CACHE_MS = 5 * 60 * 1000;

function githubHeaders(userToken = "") {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = userToken || process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function github(path, userToken = "") {
  const response = await fetch(`${API_BASE}${path}`, { headers: githubHeaders(userToken), cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = response.status === 401 || response.status === 403
      ? "GitHub rejected the configured token or its permissions. Check GITHUB_TOKEN and grant read access to the configured organization and repositories."
      : body.message || `GitHub returned ${response.status} for ${path}.`;
    const error = new Error(message);
    error.status = response.status === 404 ? 400 : 502;
    throw error;
  }
  return response.json();
}

async function graphQL(query, variables, userToken = "") {
  const token = userToken || process.env.GITHUB_TOKEN;
  if (!token) return null;
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { ...githubHeaders(userToken), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.errors?.length) {
    throw new Error(payload.errors?.[0]?.message || `GitHub GraphQL returned ${response.status}.`);
  }
  return payload.data;
}

async function pages(path, maxPages = 2, userToken = "") {
  const results = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await github(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, userToken);
    if (!Array.isArray(batch)) break;
    results.push(...batch);
    if (batch.length < 100) break;
  }
  return results;
}

async function mapLimit(values, limit, callback) {
  const output = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      try { output[index] = await callback(values[index], index); }
      catch { output[index] = null; }
    }
  }));
  return output.filter(Boolean);
}

function initialsFor(name, login) {
  const parts = String(name || login || "GH").trim().split(/[\s-]+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts.at(-1)[0]}` : parts[0].slice(0, 2)).toUpperCase();
}

function colorFor(login) {
  return ["mint", "blue", "peach", "violet", "lavender", "pink"][Array.from(login || "").reduce((total, char) => total + char.charCodeAt(0), 0) % 6];
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

function streaks(days) {
  let run = 0;
  let best = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  let active = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].count > 0) active += 1;
    else if (index === days.length - 1) continue;
    else break;
  }
  return { current: active, best };
}

async function getContributionProfile(login, userToken = "", allowSharedToken = true) {
  if (!login || (!userToken && (!allowSharedToken || !process.env.GITHUB_TOKEN))) return null;
  const from = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){login name bio company location avatarUrl url followers{totalCount} contributionsCollection(from:$from,to:$to){totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions totalIssueContributions contributionCalendar{totalContributions weeks{contributionDays{date contributionCount}}}}}}`;
  const data = await graphQL(query, { login, from, to }, userToken);
  const user = data?.user;
  if (!user) return null;
  const collection = user.contributionsCollection;
  const days = collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays.map((day) => ({
    date: day.date,
    count: day.contributionCount,
    level: day.contributionCount === 0 ? 0 : day.contributionCount < 3 ? 1 : day.contributionCount < 6 ? 2 : day.contributionCount < 10 ? 3 : 4,
  })));
  return {
    profile: {
      login: user.login,
      name: user.name || user.login,
      bio: user.bio || "",
      company: user.company || "",
      location: user.location || "",
      avatarUrl: user.avatarUrl,
      url: user.url,
      followers: user.followers.totalCount,
    },
    contributions: {
      total: collection.contributionCalendar.totalContributions,
      commits: collection.totalCommitContributions,
      pullRequests: collection.totalPullRequestContributions,
      reviews: collection.totalPullRequestReviewContributions,
      issues: collection.totalIssueContributions,
      days,
      ...streaks(days),
    },
  };
}

async function getRepositories(userToken = "", personalLogin = "") {
  if (personalLogin) {
    const repositories = await pages(`/users/${encodeURIComponent(personalLogin)}/repos?type=owner&sort=updated&direction=desc`, 10, userToken);
    return repositories.filter((repository) => !repository.private);
  }
  if (userToken) return pages("/user/repos?visibility=public&affiliation=owner&sort=updated&direction=desc", 10, userToken);
  const configuredRepos = (process.env.GITHUB_REPOS || "").split(",").map((repo) => repo.trim()).filter(Boolean);
  const org = process.env.GITHUB_ORG?.trim();
  let repos;
  if (configuredRepos.length) {
    repos = await mapLimit(configuredRepos, 8, async (repo) => github(`/repos/${repo}`));
  } else if (org) {
    repos = await pages(`/orgs/${encodeURIComponent(org)}/repos?type=all&sort=updated`, Number(process.env.GITHUB_REPO_PAGES || 2));
  } else {
    throw Object.assign(new Error("Connect GitHub by setting GITHUB_ORG or a comma-separated GITHUB_REPOS list in .env.local."), { status: 503 });
  }
  return repos.slice(0, Number(process.env.GITHUB_MAX_REPOS || 100));
}

async function getDashboardFromGitHub(primaryLoginOverride = "", userToken = "", personalWorkspace = false, { includePrimaryProfile = true, publicOnly = false, allowSharedGraphqlToken = true } = {}) {
  const fetchedRepoRows = await getRepositories(userToken, personalWorkspace ? primaryLoginOverride : "");
  const repoRows = publicOnly ? fetchedRepoRows.filter((repo) => !repo.private) : fetchedRepoRows;
  const repoData = await mapLimit(repoRows, 8, async (repo) => {
    const [languages, contributors, pulls] = await Promise.all([
      github(`/repos/${repo.full_name}/languages`, userToken).catch(() => ({})),
      github(`/repos/${repo.full_name}/contributors?per_page=100`, userToken).catch(() => []),
      github(`/repos/${repo.full_name}/pulls?state=all&sort=updated&direction=desc&per_page=10`, userToken).catch(() => []),
    ]);
    return { repo, languages, contributors, pulls };
  });

  const peopleMap = new Map();
  const projects = repoData.map(({ repo, languages, contributors }) => {
    const repoContributors = [];
    const collaboratorStats = [];
    contributors.forEach((contributor) => {
      if (!contributor.login) return;
      const person = peopleMap.get(contributor.login) || {
        id: contributor.login,
        login: contributor.login,
        name: contributor.login,
        initials: initialsFor(contributor.login, contributor.login),
        avatar: contributor.avatar_url,
        url: contributor.html_url,
        role: "GitHub contributor",
        team: "",
        teams: [],
        location: "",
        bio: "",
        color: colorFor(contributor.login),
        commits: 0,
        prs: 0,
        reviews: 0,
        status: "GitHub contributor",
        repositories: [],
      };
      person.commits += contributor.contributions || 0;
      person.repositories.push(repo.full_name);
      peopleMap.set(contributor.login, person);
      repoContributors.push(contributor.login);
      collaboratorStats.push({ login: contributor.login, contributions: contributor.contributions || 0, avatar: contributor.avatar_url, url: contributor.html_url });
    });
    const stack = Object.entries(languages).sort((left, right) => right[1] - left[1]).map(([language]) => language);
    const daysSincePush = Math.floor((Date.now() - new Date(repo.pushed_at || repo.updated_at).getTime()) / 86400000);
    return {
      id: repo.full_name,
      repo: repo.full_name,
      name: repo.name,
      description: repo.description || "",
      status: repo.archived ? "Archived" : daysSincePush <= 30 ? "Active" : "Quiet",
      stars: repo.stargazers_count,
      updated: timeAgo(repo.pushed_at || repo.updated_at),
      updatedAt: repo.pushed_at || repo.updated_at,
      stack,
      team: repoContributors,
      contributors: collaboratorStats,
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      archived: repo.archived,
      private: repo.private,
      forks: repo.forks_count,
      openIssues: repo.open_issues_count,
      languageBreakdown: languages,
    };
  });

  const org = userToken || personalWorkspace ? "" : process.env.GITHUB_ORG?.trim();
  let teams = [];
  if (org) {
    try {
      const organizationMembers = await pages(`/orgs/${encodeURIComponent(org)}/members`, Number(process.env.GITHUB_MEMBER_PAGES || 2));
      organizationMembers.forEach((member) => {
        if (!member.login || peopleMap.has(member.login)) return;
        peopleMap.set(member.login, {
          id: member.login,
          login: member.login,
          name: member.login,
          initials: initialsFor(member.login, member.login),
          avatar: member.avatar_url,
          url: member.html_url,
          role: "Organization member",
          team: "",
          teams: [],
          location: "",
          bio: "",
          color: colorFor(member.login),
          commits: 0,
          prs: 0,
          reviews: 0,
          status: "Organization member",
          repositories: [],
        });
      });
    } catch {
      // Organization membership requires an appropriate token permission.
    }
    try {
      const orgTeams = await pages(`/orgs/${encodeURIComponent(org)}/teams`, 1);
      const teamMemberships = await mapLimit(orgTeams, 8, async (team) => ({
        team,
        members: await pages(`/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team.slug)}/members`, 1),
      }));
      teamMemberships.forEach(({ team, members }) => {
        const ids = [];
        members.forEach((member) => {
          const person = peopleMap.get(member.login) || {
            id: member.login,
            login: member.login,
            name: member.login,
            initials: initialsFor(member.login, member.login),
            avatar: member.avatar_url,
            url: member.html_url,
            role: "Organization member",
            team: "",
            teams: [],
            location: "",
            bio: "",
            color: colorFor(member.login),
            commits: 0,
            prs: 0,
            reviews: 0,
            status: "Organization member",
            repositories: [],
          };
          person.teams.push(team.name);
          person.team = person.teams.join(", ");
          peopleMap.set(member.login, person);
          ids.push(member.login);
        });
        teams.push({ id: team.id, name: team.name, slug: team.slug, description: team.description || "", color: colorFor(team.slug), count: ids.length, memberIds: ids, url: team.html_url });
      });
    } catch {
      // Organization team data requires read:org; repo and contributor data can still load.
    }
  }

  const memberList = [...peopleMap.values()].slice(0, Number(process.env.GITHUB_MAX_PEOPLE || 100));
  const details = await mapLimit(memberList, 8, async (person) => {
    try {
      const user = await github(`/users/${encodeURIComponent(person.login)}`, userToken);
      return [person.login, user];
    } catch { return [person.login, null]; }
  });
  details.forEach(([login, user]) => {
    const person = peopleMap.get(login);
    if (!user || !person) return;
    person.name = user.name || login;
    person.initials = initialsFor(person.name, login);
    person.bio = user.bio || "";
    person.location = user.location || "";
    person.company = user.company || "";
    person.avatar = user.avatar_url;
    person.url = user.html_url;
    person.followers = user.followers;
  });

  const pullRows = repoData.flatMap(({ repo, pulls }) => pulls.map((pull) => ({ repo, pull })));
  const recentPulls = pullRows.sort((a, b) => new Date(b.pull.updated_at) - new Date(a.pull.updated_at)).slice(0, 100);
  recentPulls.forEach(({ repo, pull }) => {
    if (pull.user?.login && peopleMap.has(pull.user.login)) {
      const author = peopleMap.get(pull.user.login);
      if (pull.merged_at) author.prs += 1;
    }
  });
  const pullRequests = recentPulls.map(({ repo, pull }) => ({
    id: pull.id,
    number: pull.number,
    title: pull.title,
    state: pull.merged_at ? "merged" : pull.state,
    author: pull.user?.login || "Unknown",
    avatar: pull.user?.avatar_url || "",
    repo: repo.full_name,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    mergedAt: pull.merged_at,
    comments: pull.comments,
    reviewComments: pull.review_comments,
    url: pull.html_url,
    draft: pull.draft,
  }));

  let activity = [];
  try {
    let eventRows = [];
    if (org) {
      const events = await github(`/orgs/${encodeURIComponent(org)}/events?per_page=100`, userToken);
      const visibleRepositories = new Set(repoRows.map((repo) => repo.full_name.toLowerCase()));
      eventRows = events
        .filter((event) => !publicOnly || visibleRepositories.has((event.repo?.name || "").toLowerCase()))
        .map((event) => ({ event, repository: event.repo?.name || "" }));
    } else {
      const activityRepoLimit = Math.max(1, Math.min(50, Number(process.env.GITHUB_ACTIVITY_REPOS || 20)));
      const activeRepos = [...repoData]
        .sort((left, right) => new Date(right.repo.pushed_at || right.repo.updated_at) - new Date(left.repo.pushed_at || left.repo.updated_at))
        .slice(0, activityRepoLimit);
      const repoEvents = await mapLimit(activeRepos, 6, async ({ repo }) => {
        const events = await github(`/repos/${repo.full_name}/events?per_page=100`, userToken).catch(() => []);
        return events.map((event) => ({ event, repository: repo.full_name }));
      });
      eventRows = repoEvents.flat();
    }
    activity = eventRows
      .sort((left, right) => new Date(right.event.created_at) - new Date(left.event.created_at))
      .slice(0, 100)
      .map(({ event, repository }) => {
        const repo = event.repo?.name || repository;
        const type = event.type || "ActivityEvent";
        const payload = event.payload || {};
        const item = type === "PullRequestReviewEvent" ? payload.review : payload.pull_request;
        const commit = type === "PushEvent" ? payload.commits?.at(-1) : null;
        const subject = item?.title || payload.pull_request?.title || commit?.message?.split("\n")[0] || payload.issue?.title || payload.ref || `${type.replace(/Event$/, "")} activity`;
        const action = type === "PullRequestReviewEvent" ? "reviewed" : type === "PullRequestEvent" ? (payload.action || "updated") : type === "PushEvent" ? "pushed" : type === "IssuesEvent" ? (payload.action || "updated issue") : "updated";
        const author = event.actor?.login || "Unknown";
        const person = peopleMap.get(author);
        return {
          id: event.id,
          type: type.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase(),
          action,
          person: person?.name || author,
          login: author,
          initials: person?.initials || initialsFor(author, author),
          color: person?.color || colorFor(author),
          avatar: person?.avatar || event.actor?.avatar_url || "",
          subject,
          repo: repo.split("/").at(-1) || repo,
          repository: repo,
          time: timeAgo(event.created_at),
          createdAt: event.created_at,
          url: item?.html_url || `https://github.com/${repo}`,
        };
      });
  } catch {
    activity = [];
  }

  const primaryLogin = includePrimaryProfile ? (primaryLoginOverride || process.env.GITHUB_USERNAME || "").trim() : "";
  let primaryProfile = null;
  let contributions = { total: 0, commits: 0, pullRequests: 0, reviews: 0, issues: 0, days: [], current: 0, best: 0 };
  if (primaryLogin) {
    try {
      const data = await getContributionProfile(primaryLogin, userToken, allowSharedGraphqlToken);
      if (data) {
        primaryProfile = data.profile;
        contributions = data.contributions;
        if (!peopleMap.has(primaryLogin)) {
          peopleMap.set(primaryLogin, {
            id: primaryLogin, login: primaryLogin, name: data.profile.name,
            initials: initialsFor(data.profile.name, primaryLogin), avatar: data.profile.avatarUrl,
            url: data.profile.url, role: "GitHub account", team: "", teams: [],
            location: data.profile.location, bio: data.profile.bio, color: colorFor(primaryLogin),
            commits: contributions.commits, prs: contributions.pullRequests,
            reviews: contributions.reviews, status: "GitHub account", repositories: [],
          });
        }
        const primaryPerson = peopleMap.get(primaryLogin);
        primaryPerson.name = data.profile.name;
        primaryPerson.initials = initialsFor(data.profile.name, primaryLogin);
        primaryPerson.bio = data.profile.bio;
        primaryPerson.location = data.profile.location;
        primaryPerson.avatar = data.profile.avatarUrl;
        primaryPerson.url = data.profile.url;
        primaryPerson.followers = data.profile.followers;
        primaryPerson.commits = contributions.commits;
        primaryPerson.prs = contributions.pullRequests;
        primaryPerson.reviews = contributions.reviews;
        primaryPerson.contributionDetails = contributions;
      }
    } catch {
      // Contribution calendar is optional; repository data still works without GraphQL access.
    }
  }

  const people = memberList.map((person) => peopleMap.get(person.login)).filter(Boolean);
  const includedLogins = new Set(people.map((person) => person.login));
  teams = teams.map((team) => ({ ...team, members: team.memberIds.filter((id) => includedLogins.has(id)).map((id) => peopleMap.get(id)).filter(Boolean) }));
  const orgPullRequestMetrics = {};
  if (org && !publicOnly) {
    try {
      const monthStart = new Date();
      monthStart.setDate(1);
      const queries = [
        `org:${org} type:pr is:merged`,
        `org:${org} type:pr is:merged merged:>=${monthStart.toISOString().slice(0, 10)}`,
        `org:${org} type:pr is:open`,
      ];
      const counts = await Promise.all(queries.map(async (query) => {
        const params = new URLSearchParams({ q: query, per_page: "1" });
        const result = await github(`/search/issues?${params}`, userToken);
        return result.total_count || 0;
      }));
      orgPullRequestMetrics.mergedPullRequests = counts[0];
      orgPullRequestMetrics.mergedThisMonth = counts[1];
      orgPullRequestMetrics.openPullRequests = counts[2];
    } catch {
      // Search rate limits should not take down repository and contribution data.
    }
  }

  const reviewEvents = activity.filter((item) => item.type === "PULL REQUEST REVIEW").length;
  const hasContributionCalendar = contributions.days.length > 0;
  const repositoryCommits = people.reduce((sum, person) => sum + person.commits, 0);
  const metrics = {
    contributions: hasContributionCalendar ? contributions.total : repositoryCommits,
    commits: hasContributionCalendar ? contributions.commits : repositoryCommits,
    repositoryCommits,
    pullRequests: hasContributionCalendar ? contributions.pullRequests : pullRequests.length,
    mergedPullRequests: orgPullRequestMetrics.mergedPullRequests ?? pullRequests.filter((pull) => pull.state === "merged").length,
    mergedThisMonth: orgPullRequestMetrics.mergedThisMonth || 0,
    openPullRequests: orgPullRequestMetrics.openPullRequests ?? pullRequests.filter((pull) => pull.state === "open").length,
    reviews: hasContributionCalendar ? contributions.reviews : reviewEvents,
    streak: contributions.current,
    bestStreak: contributions.best,
    people: people.length,
    teams: teams.length,
    activeTeams: teams.filter((team) => team.members.length > 0).length,
    repositories: projects.length,
    collaborators: people.filter((person) => person.repositories.length > 0).length,
  };

  return {
    configured: true,
    source: "github",
    organization: userToken || personalWorkspace ? `${primaryLoginOverride}'s repositories` : org || "Configured repositories",
    primaryProfile,
    metrics,
    contributions,
    people,
    teams,
    projects,
    activity: activity.slice(0, 100),
    pullRequests,
    updatedAt: new Date().toISOString(),
  };
}

export async function getDashboardData(primaryLoginOverride = "", userToken = "", personalWorkspace = false, options = {}) {
  const now = Date.now();
  const { includePrimaryProfile = true, publicOnly = false, allowSharedGraphqlToken = true } = options;
  const configKey = userToken
    ? `user:${primaryLoginOverride.toLowerCase()}:${includePrimaryProfile}:${publicOnly}:${allowSharedGraphqlToken}`
    : personalWorkspace
      ? `personal:${primaryLoginOverride.toLowerCase()}:${includePrimaryProfile}:${publicOnly}:${allowSharedGraphqlToken}`
      : `${process.env.GITHUB_ORG || process.env.GITHUB_REPOS || ""}:${includePrimaryProfile ? primaryLoginOverride || process.env.GITHUB_USERNAME || "" : ""}:${publicOnly}:${allowSharedGraphqlToken}`;
  const cache = globalThis.__covalGithubDashboards || (globalThis.__covalGithubDashboards = new Map());
  const entry = cache.get(configKey);
  if (entry?.expiresAt > now) return entry.value;
  if (entry?.promise) return entry.promise;
  const promise = getDashboardFromGitHub(primaryLoginOverride, userToken, personalWorkspace, options).then((value) => {
    cache.set(configKey, { value, expiresAt: Date.now() + CACHE_MS });
    return value;
  }).finally(() => {
    const latest = cache.get(configKey);
    if (latest?.promise === promise) cache.set(configKey, { promise: null, expiresAt: 0 });
  });
  cache.set(configKey, { promise, expiresAt: 0 });
  return promise;
}

export async function getGitHubProfile(login, userToken = "", includeContributions = false) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) throw Object.assign(new Error("Enter a valid GitHub username."), { status: 400 });
  const cache = globalThis.__covalGithubProfiles || (globalThis.__covalGithubProfiles = new Map());
  const cacheKey = `${login.toLowerCase()}:${includeContributions && userToken ? "owner-contributions" : "public-profile"}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const user = await github(`/users/${encodeURIComponent(login)}`);
  const repositoryRows = await pages(`/users/${encodeURIComponent(login)}/repos?type=owner&sort=updated&direction=desc`, 1)
    .then((rows) => rows.filter((repository) => !repository.private).slice(0, 30))
    .catch(() => []);
  const repositoryContributors = await mapLimit(repositoryRows.slice(0, 12), 6, async (repository) => {
    const contributors = await github(`/repos/${repository.full_name}/contributors?per_page=100`).catch(() => []);
    const owner = contributors.find((contributor) => contributor.login?.toLowerCase() === login.toLowerCase());
    return [repository.full_name, {
      commits: owner?.contributions || 0,
      contributors: contributors.map((contributor) => contributor.login).filter(Boolean),
    }];
  });
  const contributorsByRepository = new Map(repositoryContributors);
  const languageRows = await mapLimit(repositoryRows, 6, async (repository) => [
    repository.full_name,
    await github(`/repos/${repository.full_name}/languages`).catch(() => ({})),
  ]);
  const languagesByRepository = new Map(languageRows);
  const repositories = repositoryRows.map((repository) => {
    const contributorData = contributorsByRepository.get(repository.full_name) || { commits: 0, contributors: [] };
    const languageBreakdown = languagesByRepository.get(repository.full_name) || {};
    return {
      id: repository.full_name,
      repo: repository.full_name,
      name: repository.name,
      description: repository.description || "",
      status: repository.archived ? "Archived" : new Date(repository.pushed_at || repository.updated_at).getTime() > Date.now() - 30 * 86400000 ? "Active" : "Quiet",
      stars: repository.stargazers_count,
      updated: timeAgo(repository.pushed_at || repository.updated_at),
      updatedAt: repository.pushed_at || repository.updated_at,
      stack: Object.entries(languageBreakdown).sort((left, right) => right[1] - left[1]).map(([language]) => language),
      team: contributorData.contributors,
      contributors: contributorData.contributors.map((contributor) => ({ login: contributor })),
      url: repository.html_url,
      defaultBranch: repository.default_branch,
      archived: repository.archived,
      private: false,
      forks: repository.forks_count,
      openIssues: repository.open_issues_count,
      languageBreakdown,
    };
  });
  const publicRepoCommits = repositoryContributors.reduce((total, [, stats]) => total + stats.commits, 0);
  let contributionData = null;
  if (includeContributions && userToken) {
    try { contributionData = await getContributionProfile(login, userToken, false); } catch { contributionData = null; }
  } else {
    try { contributionData = await getContributionProfile(login, "", true); } catch { contributionData = null; }
  }
  const profile = {
    id: user.login,
    login: user.login,
    name: user.name || user.login,
    initials: initialsFor(user.name || user.login, user.login),
    avatar: user.avatar_url,
    url: user.html_url,
    role: "GitHub account",
    team: "",
    teams: [],
    bio: user.bio || "",
    company: user.company || "",
    location: user.location || "",
    color: colorFor(user.login),
    commits: contributionData?.contributions.commits ?? publicRepoCommits,
    prs: contributionData?.contributions.pullRequests || 0,
    reviews: contributionData?.contributions.reviews || 0,
    repositories,
    followers: user.followers,
    publicRepositories: user.public_repos,
    publicRepoCommits,
    publicRepoCommitRepositories: Math.min(repositoryRows.length, 12),
    contributions: contributionData?.contributions || null,
  };
  cache.set(cacheKey, { value: profile, expiresAt: Date.now() + CACHE_MS });
  return profile;
}

export function getGitHubErrorStatus(error) {
  return error?.status || 502;
}
