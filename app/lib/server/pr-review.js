// Builds COVAL's pull request comment: per-agent score changes between the base and head
// commits, plus findings that appear only in the head commit.

export const COMMENT_MARKER = "<!-- coval-pr-review -->";

const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const fmt = (value) => (value == null ? "—" : Number(value).toFixed(1).replace(/\.0$/, ""));

function scores(target) {
  return Object.fromEntries((target?.evaluations || []).filter((item) => item.status === "complete" && typeof item.score === "number").map((item) => [item.id, item.score]));
}

// Findings are matched on agent, title, and file (not line), so moved code does not look new.
const findingKey = (agentId, fix) => [agentId, fix.title, String(fix.location || "").replace(/:\d+$/, "")].join("|");

export function compareTargets(base, head) {
  const baseScores = scores(base);
  const headScores = scores(head);
  const rows = (head?.evaluations || []).map((item) => ({
    id: item.id,
    label: item.label,
    base: baseScores[item.id] ?? null,
    head: headScores[item.id] ?? null,
    change: baseScores[item.id] != null && headScores[item.id] != null ? headScores[item.id] - baseScores[item.id] : null,
  }));
  const baseKeys = new Set((base?.evaluations || []).flatMap((item) => (item.fixes || []).map((fix) => findingKey(item.id, fix))));
  const newFindings = (head?.evaluations || []).flatMap((item) => (item.fixes || [])
    .filter((fix) => !baseKeys.has(findingKey(item.id, fix)))
    .map((fix) => ({ ...fix, agent: item.label })));
  return {
    rows,
    baseOverall: average(Object.values(baseScores)),
    headOverall: average(Object.values(headScores)),
    newFindings,
  };
}

function changeCell(change) {
  if (change == null) return "—";
  if (Math.abs(change) < 0.05) return "±0";
  return change > 0 ? `🟢 +${fmt(change)}` : `🔴 ${fmt(change)}`;
}

export function renderComment(comparison, { repoUrl, headSha, appUrl }) {
  const overallChange = comparison.headOverall != null && comparison.baseOverall != null ? comparison.headOverall - comparison.baseOverall : null;
  const regressions = comparison.rows.filter((row) => row.change != null && row.change <= -1);
  const headline = overallChange == null
    ? `**COVAL score: ${fmt(comparison.headOverall)}/100**`
    : `**COVAL score: ${fmt(comparison.baseOverall)} → ${fmt(comparison.headOverall)}** (${changeCell(overallChange)})`;
  const summary = regressions.length
    ? `This pull request lowers ${regressions.length === 1 ? "one area" : `${regressions.length} areas`}: ${regressions.map((row) => row.label).join(", ")}.`
    : "No area got worse in this pull request. 👍";
  const lines = [
    COMMENT_MARKER,
    `### COVAL code review`,
    "",
    headline,
    "",
    summary,
    "",
    "| Agent | Base | This PR | Change |",
    "|---|---:|---:|---:|",
    ...[...comparison.rows].sort((a, b) => (a.change ?? 0) - (b.change ?? 0)).map((row) => `| ${row.label} | ${fmt(row.base)} | ${fmt(row.head)} | ${changeCell(row.change)} |`),
  ];
  const findings = comparison.newFindings.slice(0, 6);
  if (findings.length) {
    lines.push("", `<details open><summary><b>New findings (${comparison.newFindings.length})</b></summary>`, "");
    for (const fix of findings) {
      const match = String(fix.location || "").match(/^(.*?)(?::(\d+))?$/);
      const link = match?.[1] ? `${repoUrl}/blob/${headSha}/${match[1]}${match[2] ? `#L${match[2]}` : ""}` : "";
      lines.push(`- **${fix.agent}:** ${fix.title}${link ? ` — [\`${fix.location}\`](${link})` : ""}${fix.detail ? `<br><sub>${fix.detail}</sub>` : ""}`);
    }
    lines.push("", "</details>");
  }
  lines.push("", `<sub>Scored by ten automated review agents at ${headSha.slice(0, 7)}. ${appUrl ? `[Open COVAL](${appUrl}) for full reports and AI fix explanations.` : ""}</sub>`);
  return lines.join("\n");
}
