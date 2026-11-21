// Profile portfolio options, shared by the API (validation) and the profile page (display).

export const PORTFOLIO_ACCENTS = {
  sage: { label: "Sage", color: "#64806a" },
  ocean: { label: "Ocean", color: "#2f6fb0" },
  violet: { label: "Violet", color: "#6d5bd0" },
  amber: { label: "Amber", color: "#b7791f" },
  rose: { label: "Rose", color: "#c2416b" },
  graphite: { label: "Graphite", color: "#3f3f46" },
};

export const PORTFOLIO_STATUSES = {
  "": "No badge",
  open_to_work: "Open to work",
  hiring: "Hiring",
  collaborate: "Open to collaborate",
};

export const PORTFOLIO_SECTIONS = {
  scores: "Code evaluation scores",
  contributions: "Contributions",
  languages: "Languages and community",
  collaborators: "Collaborators",
};

export const DEFAULT_PORTFOLIO = { accent: "sage", status: "", skills: [], links: [], sectionOrder: Object.keys(PORTFOLIO_SECTIONS) };

const MAX_SKILLS = 15;
const MAX_LINKS = 5;

function fail(message) {
  throw Object.assign(new Error(message), { status: 400 });
}

// Returns a clean portfolio from stored or submitted data. With `strict`, bad input throws
// (for saving); otherwise bad parts fall back to defaults (for reading).
export function normalizePortfolio(input, { strict = false } = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const accent = Object.hasOwn(PORTFOLIO_ACCENTS, source.accent) ? source.accent : (strict && source.accent ? fail("Choose one of the accent colors.") : DEFAULT_PORTFOLIO.accent);
  const status = Object.hasOwn(PORTFOLIO_STATUSES, source.status ?? "") ? source.status || "" : (strict ? fail("Choose a valid status badge.") : "");

  const rawSkills = Array.isArray(source.skills) ? source.skills : [];
  if (strict && rawSkills.length > MAX_SKILLS) fail(`Add up to ${MAX_SKILLS} skills.`);
  const skills = [...new Set(rawSkills.filter((skill) => typeof skill === "string").map((skill) => skill.trim()).filter(Boolean))];
  if (strict && skills.some((skill) => skill.length > 32)) fail("Keep each skill under 32 characters.");

  const rawLinks = Array.isArray(source.links) ? source.links : [];
  if (strict && rawLinks.length > MAX_LINKS) fail(`Add up to ${MAX_LINKS} links.`);
  const links = [];
  for (const link of rawLinks) {
    const label = typeof link?.label === "string" ? link.label.trim() : "";
    const url = typeof link?.url === "string" ? link.url.trim() : "";
    if (!url && !label) continue;
    let valid = false;
    try { valid = new URL(url).protocol === "https:" && url.length <= 200; } catch { valid = false; }
    if (!valid || label.length > 30) {
      if (strict) fail("Links must start with https:// (up to 200 characters), with a label under 30 characters.");
      continue;
    }
    links.push({ label: label || new URL(url).hostname.replace(/^www\./, ""), url });
  }

  const known = Object.keys(PORTFOLIO_SECTIONS);
  const requested = Array.isArray(source.sectionOrder) ? source.sectionOrder.filter((key) => known.includes(key)) : [];
  const sectionOrder = [...new Set([...requested, ...known])];

  return { accent, status, skills: skills.slice(0, MAX_SKILLS), links: links.slice(0, MAX_LINKS), sectionOrder };
}
