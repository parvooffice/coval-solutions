import app from "./app.js";

const port = Number(process.env.PORT || 3001);
const httpServer = app.listen(port, "0.0.0.0", () => console.info(`COVAL Express API listening on ${port}`));

async function shutdown() {
  httpServer.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
