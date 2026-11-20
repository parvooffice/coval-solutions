// Retrieval for the report chatbot: split a member's saved evaluation into small
// passages and pick the ones most relevant to a question (BM25-style keyword scoring).

const STOP_WORDS = new Set("a an and are as at be by can do does for from has have how i in is it its me my of on or our so that the this to was what when where which who why will with you your".split(" "));

function tokens(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9_]+/g)?.filter((word) => word.length > 1 && !STOP_WORDS.has(word)) || [];
}

const score = (value) => (value == null ? "unavailable" : `${Number(value).toFixed(1).replace(/\.0$/, "")}/100`);

export function reportPassages(report, targetUrl = "") {
  const passages = [];
  const targets = (report?.targets || []).filter((target) => !targetUrl || String(target.url || target.input).toLowerCase() === targetUrl.toLowerCase());
  for (const target of targets) {
    const name = target.name || target.url || "repository";
    const evaluations = target.evaluations || [];
    const complete = evaluations.filter((item) => item.status === "complete" && item.score != null);
    const overall = complete.length ? complete.reduce((sum, item) => sum + Number(item.score), 0) / complete.length : null;
    passages.push({
      id: `${name}:overview`,
      text: `Repository ${name} (${target.url || target.input}). Overall ${score(overall)} across ${complete.length} agents, evaluated ${target.generatedAt || "recently"}. `
        + evaluations.map((item) => `${item.label}: ${score(item.score)}${target.previous?.scores?.[item.id] != null ? ` (previously ${score(target.previous.scores[item.id])})` : ""}`).join("; ") + ".",
      always: true,
    });
    for (const item of evaluations) {
      const breakdown = Object.entries(item.breakdown || {})
        .map(([key, value]) => `${(typeof value === "object" && value?.label) || key.replaceAll("_", " ")} ${score(typeof value === "object" ? value?.score : value)}`)
        .join("; ");
      passages.push({
        id: `${name}:${item.id}`,
        text: `${name} — ${item.label} agent: ${score(item.score)}${item.grade ? `, grade ${item.grade}` : ""}. ${item.summary || item.error || ""}${breakdown ? ` Breakdown: ${breakdown}.` : ""}`,
      });
      (item.fixes || []).forEach((fix, index) => passages.push({
        id: `${name}:${item.id}:fix${index + 1}`,
        text: `${name} — ${item.label} fix ${index + 1}: ${fix.title}${fix.location ? ` at ${fix.location}` : ""}. ${fix.detail || ""}`,
      }));
    }
  }
  return passages;
}

export function retrieve(passages, question, limit = 14) {
  const queryTerms = [...new Set(tokens(question))];
  const documents = passages.map((passage) => tokens(passage.text));
  const averageLength = documents.reduce((sum, words) => sum + words.length, 0) / Math.max(documents.length, 1);
  const documentFrequency = new Map();
  for (const words of documents) for (const word of new Set(words)) documentFrequency.set(word, (documentFrequency.get(word) || 0) + 1);
  const ranked = passages.map((passage, index) => {
    const words = documents[index];
    let total = 0;
    for (const term of queryTerms) {
      const frequency = words.filter((word) => word === term || (term.length > 4 && word.startsWith(term.slice(0, -1)))).length;
      if (!frequency) continue;
      const idf = Math.log(1 + (passages.length - (documentFrequency.get(term) || 0) + 0.5) / ((documentFrequency.get(term) || 0) + 0.5));
      total += idf * ((frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * (words.length / Math.max(averageLength, 1)))));
    }
    return { passage, total };
  });
  const always = ranked.filter((item) => item.passage.always).map((item) => item.passage);
  const relevant = ranked.filter((item) => !item.passage.always && item.total > 0).sort((a, b) => b.total - a.total).map((item) => item.passage);
  // With no keyword hits (e.g. "what should I fix first?"), fall back to every agent's first fixes.
  const fallback = relevant.length ? [] : passages.filter((passage) => !passage.always && (/:fix1$/.test(passage.id) || !/:fix\d+$/.test(passage.id)));
  return [...always.slice(0, 5), ...(relevant.length ? relevant : fallback)].slice(0, limit + Math.min(always.length, 5));
}
