import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
// Static imports so serverless bundlers (Vercel) trace and ship every route module.
import * as dashboard from "../app/api/dashboard/route.js";
import * as members from "../app/api/members/route.js";
import * as presence from "../app/api/presence/route.js";
import * as githubRepositories from "../app/api/github-repositories/route.js";
import * as codeEvaluation from "../app/api/code-evaluation/route.js";
import * as profile from "../app/api/profile/route.js";
import * as profileBanner from "../app/api/profile/banner/route.js";
import * as connections from "../app/api/connections/route.js";
import * as conversations from "../app/api/conversations/route.js";
import * as messages from "../app/api/messages/route.js";
import * as notifications from "../app/api/notifications/route.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV ||= "production";

const apiRoutes = [
  ["/api/dashboard", dashboard],
  ["/api/members", members],
  ["/api/presence", presence],
  ["/api/github-repositories", githubRepositories],
  ["/api/code-evaluation", codeEvaluation],
  ["/api/profile", profile],
  ["/api/profile/banner", profileBanner],
  ["/api/connections", connections],
  ["/api/conversations", conversations],
  ["/api/messages", messages],
  ["/api/notifications", notifications],
];

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
) && Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use("/api", (request, response, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.get("origin");
    const hostOrigin = `${request.protocol}://${request.get("host")}`;
    if (origin && origin !== hostOrigin) return response.status(403).json({ error: "Cross-origin API requests are not allowed." });
    if (request.get("sec-fetch-site") === "cross-site") return response.status(403).json({ error: "Cross-site API requests are not allowed." });
  }
  next();
});
app.get("/api/health", (_request, response) => response.json({ ok: true, database: supabaseConfigured ? "supabase" : "not configured" }));

for (const [routePath, handlers] of apiRoutes) {
  const forward = async (request, response, next) => {
    try {
      const method = request.method.toUpperCase();
      const handler = handlers[method];
      if (!handler) return response.status(405).json({ error: "Method not allowed." });
      const headers = new Headers(request.headers);
      const hasBody = !["GET", "HEAD"].includes(method);
      const webRequest = new Request(`${request.protocol}://${request.get("host")}${request.originalUrl}`, {
        method,
        headers,
        ...(hasBody ? { body: Readable.toWeb(request), duplex: "half" } : {}),
      });
      const result = await handler(webRequest);
      response.status(result.status);
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.send(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  };
  app.all(routePath, forward);
  if (routePath === "/api/profile/banner") app.get(`${routePath}/:fileId`, forward);
}

// On Vercel the CDN serves app/dist; these routes cover Docker and `npm start`.
const clientBuild = path.join(root, "app", "dist");
app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found." }));
app.use(express.static(clientBuild));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(clientBuild, "index.html")));
app.use((error, _request, response, _next) => {
  console.error("API request failed:", error);
  response.status(error.status || 500).json({ error: "The server could not complete this request." });
});

export default app;
