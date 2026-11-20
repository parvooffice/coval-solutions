import { loadSharedReport } from "../../lib/server/shared-reports.js";

const COLORS = { A: "#2f9e6e", B: "#5f9b7a", C: "#c99a2e", D: "#d97706", F: "#dc2626" };

function grade(score) {
  if (score == null) return "";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

const escapeXml = (value) => String(value).replace(/[<>&"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Shields-style SVG: "COVAL | 82 · B". Text widths are estimated (about 6.5px per character at 11px).
export function badgeSvg(label, value, color) {
  const left = Math.round(label.length * 6.5 + 14);
  const right = Math.round(value.length * 6.5 + 14);
  const width = left + right;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(`${label}: ${value}`)}">
<title>${escapeXml(`${label}: ${value}`)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${left}" height="20" fill="#18181b"/><rect x="${left}" width="${right}" height="20" fill="${color}"/><rect width="${width}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${left / 2}" y="14">${escapeXml(label)}</text><text x="${left + right / 2}" y="14">${escapeXml(value)}</text></g></svg>`;
}

export async function GET(request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  let value = "not found";
  let color = "#71717a";
  try {
    const report = await loadSharedReport(token);
    if (report) {
      const scores = (report.evaluations || []).filter((item) => item.status === "complete" && typeof item.score === "number").map((item) => item.score);
      const overall = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
      if (overall != null) {
        const letter = grade(overall);
        value = `${Math.round(overall)} · ${letter}`;
        color = COLORS[letter];
      } else {
        value = "no score";
      }
    }
  } catch {
    value = "unavailable";
  }
  return new Response(badgeSvg("COVAL", value, color), {
    headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=3600, s-maxage=3600" },
  });
}
