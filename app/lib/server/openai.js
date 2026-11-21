// Minimal OpenAI Chat Completions client shared by the report assistant and finding explanations.
export async function chatCompletion(messages, { maxTokens = 500, temperature = 0.2 } = {}) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw Object.assign(new Error("The AI assistant is not configured. Add OPENAI_API_KEY to the web app's environment."), { status: 503 });
  const baseUrl = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini", temperature, max_tokens: maxTokens, messages }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw Object.assign(new Error(error?.name === "TimeoutError" ? "The assistant took too long to answer. Try again." : "COVAL could not reach OpenAI."), { status: 504 });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code || payload?.error?.type || "";
    // Logged for the site owner (Vercel → Logs); members see a plain explanation below.
    console.error(`OpenAI request failed: ${response.status} ${code} ${payload?.error?.message || ""}`.trim());
    if (code === "insufficient_quota") {
      throw Object.assign(new Error("The AI assistant is unavailable right now: COVAL's OpenAI account has run out of credit. The site owner needs to add credit at platform.openai.com → Billing."), { status: 503 });
    }
    if (response.status === 401 || code === "invalid_api_key") {
      throw Object.assign(new Error("The AI assistant is unavailable right now: COVAL's OpenAI key isn't valid. The site owner needs to update OPENAI_API_KEY."), { status: 503 });
    }
    if (response.status === 404 || code === "model_not_found") {
      throw Object.assign(new Error("The AI assistant is unavailable right now: the OpenAI model in OPENAI_MODEL isn't available to COVAL's account."), { status: 503 });
    }
    const status = response.status === 429 ? 429 : 502;
    throw Object.assign(new Error(status === 429 ? "The assistant is getting a lot of questions right now. Try again in a minute." : "OpenAI could not answer this request."), { status });
  }
  const answer = payload?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw Object.assign(new Error("OpenAI returned an empty answer."), { status: 502 });
  return answer;
}
