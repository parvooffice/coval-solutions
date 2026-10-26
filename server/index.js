import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.NODE_ENV ||= "production";
const app = express();
const apiRoutes = [
  ["/api/dashboard", "../app/api/dashboard/route.js"],
  ["/api/members", "../app/api/members/route.js"],
  ["/api/presence", "../app/api/presence/route.js"],
  ["/api/github-repositories", "../app/api/github-repositories/route.js"],
  ["/api/code-evaluation", "../app/api/code-evaluation/route.js"],
  ["/api/profile", "../app/api/profile/route.js"],
  ["/api/profile/banner", "../app/api/profile/banner/route.js"],
  ["/api/connections", "../app/api/connections/route.js"],
  ["/api/conversations", "../app/api/conversations/route.js"],
  ["/api/messages", "../app/api/messages/route.js"],
  ["/api/notifications", "../app/api/notifications/route.js"],
];

const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
) && Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);

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

for (const [routePath, modulePath] of apiRoutes) {
  const handlers = await import(new URL(modulePath, import.meta.url));
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

const clientBuild = path.join(root, "app", "dist");
app.use("/api", (_request, response) => response.status(404).json({ error: "API route not found." }));
app.use(express.static(clientBuild));
app.get("/{*path}", (_request, response) => response.sendFile(path.join(clientBuild, "index.html")));
app.use((error, _request, response, _next) => {
  console.error("API request failed:", error);
  response.status(error.status || 500).json({ error: "The server could not complete this request." });
});

const port = Number(process.env.PORT || 3001);
const httpServer = app.listen(port, "0.0.0.0", () => console.info(`COVAL Express API listening on ${port}`));

async function shutdown() {
  httpServer.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
