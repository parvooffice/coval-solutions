import { createHmac, timingSafeEqual } from "node:crypto";

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  return value;
}

export function signPublicReport(userId, githubLogin, report) {
  const secret = process.env.CODE_EVALUATION_FUNCTION_SECRET?.trim();
  if (!secret) throw Object.assign(new Error("Shared score signing is not configured."), { status: 503 });
  const payload = JSON.stringify({ userId, githubLogin, report: canonicalJson(report) });
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function hasValidPublicSignature(row) {
  try {
    const expected = Buffer.from(signPublicReport(row.user_id, row.github_login, row.public_report), "base64url");
    const actual = Buffer.from(row.public_signature || "", "base64url");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
