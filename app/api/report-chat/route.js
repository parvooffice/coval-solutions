import { apiError, requireUser } from "../../lib/server/auth.js";
import { reportPassages, retrieve } from "../../lib/server/report-retrieval.js";
import { readSavedEvaluation } from "../code-evaluation/route.js";
import { consumeQuota } from "../../lib/server/billing.js";
import { chatCompletion } from "../../lib/server/openai.js";

const MAX_QUESTION = 1_000;
const MAX_HISTORY = 6;

const SYSTEM_PROMPT = [
  "You are COVAL's code-review assistant. Answer questions about the member's repository evaluation reports.",
  "Use only the report excerpts provided. If they do not contain the answer, say so and suggest re-running the agents or opening the full report.",
  "Be concrete: name the agent, the score, and the file and line of a fix when the excerpts include them.",
  "When asked what to fix first, prioritise the lowest-scoring agents and high-severity findings, and explain why in one line each.",
  "Keep answers under 200 words, use short bullet lists for steps, and never invent files, scores, or findings.",
].join(" ");

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((turn) => turn && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string")
    .slice(-MAX_HISTORY)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 2_000) }));
}

export async function POST(request) {
  try {
    const user = await requireUser(request);
    if (!process.env.OPENAI_API_KEY?.trim()) throw Object.assign(new Error("The report assistant is not configured. Add OPENAI_API_KEY to the web app's environment."), { status: 503 });
    if (Number(request.headers.get("content-length") || 0) > 32_768) throw Object.assign(new Error("Keep each question under 32 KB."), { status: 413 });

    const body = await request.json().catch(() => null);
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) throw Object.assign(new Error("Ask a question about your scores."), { status: 400 });
    if (question.length > MAX_QUESTION) throw Object.assign(new Error(`Keep questions under ${MAX_QUESTION} characters.`), { status: 400 });
    const targetUrl = typeof body?.targetUrl === "string" ? body.targetUrl.slice(0, 500) : "";

    const report = await readSavedEvaluation(user);
    const passages = reportPassages(report, targetUrl);
    if (!passages.length) throw Object.assign(new Error("Score a repository first, then ask about its results."), { status: 400 });
    const context = retrieve(passages, question);
    await consumeQuota(user, "assistant");

    const answer = await chatCompletion([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: `Report excerpts:\n${context.map((passage) => `- ${passage.text}`).join("\n")}` },
      ...cleanHistory(body?.history),
      { role: "user", content: question },
    ]);
    return Response.json(
      { answer, sources: context.filter((passage) => !passage.always).slice(0, 6).map((passage) => passage.id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
