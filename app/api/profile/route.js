import { apiError, requireUser, supabaseRest } from "../../lib/server/auth";
import { hasValidPublicSignature } from "../../lib/server/evaluation-sharing";
import { getGitHubErrorStatus, getGitHubProfile } from "../../lib/server/github";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const defaultVisibility = { contributions: true, repositories: true, activity: true, evaluations: true };

function profileSettings(member = {}) {
  const visibility = member.profile_visibility && typeof member.profile_visibility === "object" ? member.profile_visibility : {};
  return {
    profileName: member.profile_name || "",
    headline: member.profile_headline || "",
    bio: member.profile_bio || "",
    location: member.profile_location || "",
    company: member.profile_company || "",
    profileVisibility: Object.fromEntries(Object.keys(defaultVisibility).map((key) => [key, visibility[key] !== false])),
    featuredRepositories: Array.isArray(member.featured_repositories) ? member.featured_repositories : null,
  };
}

async function publicCodeEvaluations(user, memberId, visibility) {
  if (!user.token || !visibility.evaluations) return [];
  const rows = await supabaseRest(user, `coval_code_evaluations?select=user_id,public_report,public_signature,github_login,updated_at&user_id=eq.${encodeURIComponent(memberId)}&is_public=eq.true&limit=1`);
  const row = rows?.[0];
  if (!row || !hasValidPublicSignature(row)) return [];
  return (row.public_report?.targets || []).map((target) => ({
    name: target.name,
    url: target.url,
    generatedAt: target.generatedAt || row.public_report?.generatedAt || row.updated_at,
    evaluations: (target.evaluations || []).map(({ id, label, status, score, grade, summary, breakdown }) => ({ id, label, status, score, grade, summary, breakdown })),
  }));
}

function applyRepositoryVisibility(profile, settings) {
  const repositories = Array.isArray(profile.repositories) ? profile.repositories : [];
  const visibleRepositories = !settings.profileVisibility.repositories ? [] : settings.featuredRepositories
      ? repositories.filter((repository) => settings.featuredRepositories.includes(repository.repo) || settings.featuredRepositories.includes(repository.url) || settings.featuredRepositories.includes(repository.id))
    : repositories;
  return {
    ...profile,
    ...settings,
    repositories: visibleRepositories,
    contributions: settings.profileVisibility.contributions ? profile.contributions : null,
  };
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string") throw Object.assign(new Error(`${label} must be text.`), { status: 400 });
  const text = value.trim();
  if (text.length > maxLength) throw Object.assign(new Error(`${label} must be ${maxLength} characters or fewer.`), { status: 400 });
  return text;
}

export async function GET(request) {
  try {
    const user = await requireUser(request);
    const { searchParams } = new URL(request.url);
    const memberId = searchParams.get("memberId");
    if (memberId) {
      if (!uuidPattern.test(memberId)) return Response.json({ error: "Choose a valid COVAL member." }, { status: 400 });
      const [member] = await supabaseRest(user, `coval_profiles?select=user_id,github_login,display_name,avatar_url,created_at,last_seen_at,profile_name,profile_headline,profile_bio,profile_location,profile_company,profile_visibility,featured_repositories&user_id=eq.${encodeURIComponent(memberId)}&limit=1`);
      if (!member) return Response.json({ error: "COVAL member not found." }, { status: 404 });
      const settings = profileSettings(member);
      const codeEvaluations = await publicCodeEvaluations(user, member.user_id, settings.profileVisibility);
      if (!member.github_login) {
        return Response.json({
          id: `member-${member.user_id}`,
          covalUserId: member.user_id,
          login: "",
          name: settings.profileName || member.display_name || "COVAL member",
          initials: (settings.profileName || member.display_name || "COVAL member").split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase(),
          avatar: member.avatar_url || "",
          url: "",
          role: settings.headline || "COVAL member",
          bio: settings.bio,
          location: settings.location,
          company: settings.company,
          color: "mint",
          commits: 0,
          prs: 0,
          reviews: 0,
          repositories: [],
          followers: 0,
          publicRepositories: 0,
          contributions: null,
          ...settings,
          codeEvaluations,
          createdAt: member.created_at,
          isActive: Boolean(member.last_seen_at && Date.now() - new Date(member.last_seen_at).getTime() <= 3 * 60 * 1000),
        }, { headers: { "Cache-Control": "private, no-store" } });
      }
      const isOwnMember = member.user_id === user.id && user.githubConnected;
      const githubProfile = await getGitHubProfile(member.github_login, isOwnMember ? user.githubToken : "", isOwnMember);
      const profile = applyRepositoryVisibility(githubProfile, settings);
      return Response.json({ ...profile, name: settings.profileName || githubProfile.name, bio: settings.bio, location: settings.location, company: settings.company, role: settings.headline || "COVAL member", codeEvaluations, covalUserId: member.user_id, createdAt: member.created_at }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const login = searchParams.get("login");
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login || "")) return Response.json({ error: "Enter a valid GitHub username." }, { status: 400 });
    const [covalMember] = await supabaseRest(user, `coval_profiles?select=user_id,profile_name,profile_headline,profile_bio,profile_location,profile_company,profile_visibility,featured_repositories&github_login=ilike.${encodeURIComponent(login || "")}&limit=1`);
    const isOwnGitHubProfile = user.githubConnected && user.login?.toLowerCase() === login?.toLowerCase();
    const profile = await getGitHubProfile(login, isOwnGitHubProfile ? user.githubToken : "", isOwnGitHubProfile);
    const settings = profileSettings(covalMember);
    const codeEvaluations = covalMember ? await publicCodeEvaluations(user, covalMember.user_id, settings.profileVisibility) : [];
    const visibleProfile = applyRepositoryVisibility(profile, settings);
    return Response.json({ ...visibleProfile, name: settings.profileName || profile.name, bio: settings.bio, location: settings.location, company: settings.company, role: settings.headline || "COVAL member", codeEvaluations, covalUserId: covalMember?.user_id || "" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (!error.status) error.status = getGitHubErrorStatus(error);
    return apiError(error);
  }
}

export async function PUT(request) {
  try {
    const user = await requireUser(request);
    if (!user.token) return Response.json({ error: "Sign in to customize your public profile." }, { status: 401 });
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Object.assign(new Error("Submit valid profile settings."), { status: 400 });
    const visibilityInput = body?.profileVisibility;
    const keys = Object.keys(defaultVisibility);
    if (!visibilityInput || typeof visibilityInput !== "object" || Array.isArray(visibilityInput)) {
      throw Object.assign(new Error("Choose which profile sections to show."), { status: 400 });
    }
    if (keys.some((key) => typeof visibilityInput[key] !== "boolean")) throw Object.assign(new Error("Choose whether each profile section is visible."), { status: 400 });
    const profileVisibility = Object.fromEntries(keys.map((key) => [key, visibilityInput[key] !== false]));
    if (!Array.isArray(body.featuredRepositories) || body.featuredRepositories.length > 100 || body.featuredRepositories.some((item) => typeof item !== "string" || item.length > 300)) {
      throw Object.assign(new Error("Choose up to 100 repositories to feature."), { status: 400 });
    }
    const values = {
      profile_name: boundedText(body.profileName || "", "Display name", 80),
      profile_headline: boundedText(body.headline || "", "Headline", 120),
      profile_bio: boundedText(body.bio || "", "About", 500),
      profile_location: boundedText(body.location || "", "Location", 100),
      profile_company: boundedText(body.company || "", "Organization", 100),
      profile_visibility: profileVisibility,
      featured_repositories: [...new Set(body.featuredRepositories.map((item) => item.trim()).filter(Boolean))],
      updated_at: new Date().toISOString(),
    };
    const updated = await supabaseRest(user, `coval_profiles?user_id=eq.${encodeURIComponent(user.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(values),
    });
    if (!updated?.length) return Response.json({ error: "Your COVAL profile was not found." }, { status: 404 });
    return Response.json({ profile: profileSettings(updated[0]) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
