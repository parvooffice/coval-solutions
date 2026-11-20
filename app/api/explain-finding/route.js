import { apiError, requireUser } from "../../lib/server/auth.js";
import { consumeQuota } from "../../lib/server/billing.js";
import { chatCompletion } from "../../lib/server/openai.js";

const CONTEXT_LINES = 20;
const MAX_SNIPPET = 6_000;

const SYSTEM_PROMPT = [
  "You are COVAL's code-review assistant. Explain one finding from an automated code review and how to fix it.",
  "Reply in Markdown with exactly three short sections: **Why it matters** (1-2 sentences), **How to fix** (numbered steps), and **Suggested change** (one fenced code block, only when the snippet is provided).",
  "Base the change only on the snippet shown; keep the original style and language. If the finding looks like a false positive given the snippet, say so plainly and explain why.",
  "Stay under 220 words.",
].join(" ");

function parseRepository(url) {
  const match = String(url || "").match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return match ? { owner: match[1], repo: match[2] } : null;
}

function parseLocation(location) {
  const match = String(location || "").match(/^([^:]+?)(?::(\d+))?$/);
  if (!match || match[1].includes("..") || match[1].startsWith("/")) return null;
  return { path: match[1], line: match[2] ? Number(match[2]) : null };
}

// Fetch ±20 lines around the finding. Uses the member's GitHub token when present (private repos
// they can read), otherwise public access. Returns "" when the file cannot be read.
async function fetchSnippet(repository, location, githubToken) {
  if (!repository || !location) return "";
  const encodedPath = location.path.split("/").map(encodeURIComponent).join("/");
  const headers = { Accept: "application/vnd.github.raw", "User-Agent": "COVAL-explain", "X-GitHub-Api-Version": "2022-11-28" };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/contents/${encodedPath}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return "";
    const lines = (await response.text()).split("\n");
    const center = location.line ? location.line - 1 : 0;
    const start = Math.max(0, center - CONTEXT_LINES);
    const end = Math.min(lines.length, center + CONTEXT_LINES + 1);
    return lines.slice(start, end).map((line, index) => `${String(start + index + 1).padStart(5)}${start + index === center && location.line ? " >" : "  "} ${line}`).join("\n").slice(0, MAX_SNIPPET);
  } catch {
    return "";
  }
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    const body = await request.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.slice(0, 300) : "";
    if (!title) throw Object.assign(new Error("Choose a finding to explain."), { status: 400 });
    const agent = typeof body.agent === "string" ? body.agent.slice(0, 60) : "Code review";
    const detail = typeof body.detail === "string" ? body.detail.slice(0, 600) : "";
    const locationText = typeof body.location === "string" ? body.location.slice(0, 300) : "";
    const repository = parseRepository(body.targetUrl);
    const location = parseLocation(locationText);

    await consumeQuota(user, "assistant");
    const snippet = await fetchSnippet(repository, location, user.githubToken);
    const answer = await chatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `Agent: ${agent}`,
          `Finding: ${title}`,
          detail && `Detail: ${detail}`,
          locationText && `Location: ${locationText}`,
          snippet ? `Code (line numbers on the left, ">" marks the reported line):\n\`\`\`\n${snippet}\n\`\`\`` : "The source code could not be fetched; explain the finding in general terms.",
        ].filter(Boolean).join("\n"),
      },
    ], { maxTokens: 600 });
    return Response.json({ answer, usedCode: Boolean(snippet) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
