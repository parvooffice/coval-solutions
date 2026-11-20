import { apiError, requireUser } from "../../lib/server/auth.js";
import { reportPassages, retrieve } from "../../lib/server/report-retrieval.js";
import { readSavedEvaluation } from "../code-evaluation/route.js";
import { consumeQuota } from "../../lib/server/billing.js";

const MAX_QUESTION = 1_000;
const MAX_HISTORY = 6;
const DEFAULT_MODEL = "gpt-4o-mini";

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
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw Object.assign(new Error("The report assistant is not configured. Add OPENAI_API_KEY to the web app's environment."), { status: 503 });
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

    let response;
    try {
      const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL,
          temperature: 0.2,
          max_tokens: 500,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "system", content: `Report excerpts:\n${context.map((passage) => `- ${passage.text}`).join("\n")}` },
            ...cleanHistory(body?.history),
            { role: "user", content: question },
          ],
        }),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw Object.assign(new Error(error?.name === "TimeoutError" ? "The assistant took too long to answer. Try again." : "COVAL could not reach OpenAI."), { status: 504 });
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const status = response.status === 429 ? 429 : 502;
      throw Object.assign(new Error(status === 429 ? "The assistant is busy or over its usage limit. Try again shortly." : "OpenAI could not answer this question."), { status });
    }
    const answer = payload?.choices?.[0]?.message?.content?.trim();
    if (!answer) throw Object.assign(new Error("OpenAI returned an empty answer."), { status: 502 });
    return Response.json(
      { answer, sources: context.filter((passage) => !passage.always).slice(0, 6).map((passage) => passage.id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return apiError(error);
  }
}
