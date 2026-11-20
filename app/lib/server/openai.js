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
    const status = response.status === 429 ? 429 : 502;
    throw Object.assign(new Error(status === 429 ? "The assistant is busy or over its usage limit. Try again shortly." : "OpenAI could not answer this request."), { status });
  }
  const answer = payload?.choices?.[0]?.message?.content?.trim();
  if (!answer) throw Object.assign(new Error("OpenAI returned an empty answer."), { status: 502 });
  return answer;
}
