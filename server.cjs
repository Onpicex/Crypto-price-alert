const express = require("express");
const cors = require("cors");
const { serveStatic } = require("./lib/api-static.cjs");
const { handleRequest, initializeAuth } = require("./lib/api.cjs");
const { startMonitor, stopMonitor, getEngineStatus } = require("./lib/monitor-engine.cjs");
const { closeDb } = require("./lib/db.cjs");

const PORT = process.env.PORT || 3847;
const HOST = process.env.HOST || "0.0.0.0";

const app = express();

app.use(cors());
app.use(express.json());

// API routes first
app.all("/health", async (req, res) => {
  res.json({ status: "ok", engine: getEngineStatus() });
});

app.all("/price-alert/api/:path(*)", async (req, res) => {
  const apiPath = "/api/" + req.params.path;
  const result = await handleRequest(req.method, apiPath, req.body, req.headers);
  res.status(result.status).json(result.data);
});

app.all("/api/:path(*)", async (req, res) => {
  const result = await handleRequest(req.method, req.path, req.body, req.headers);
  res.status(result.status).json(result.data);
});

// Static files last (catch-all)
app.use("/", serveStatic);

async function main() {
  initializeAuth();
  startMonitor();
  
  app.listen(PORT, HOST, () => {
    console.log(`[PriceAlert] Server running on http://${HOST}:${PORT}`);
    console.log(`[PriceAlert] UI: http://${HOST}:${PORT}/`);
  });
}

process.on("SIGINT", () => {
  console.log("\n[PriceAlert] Shutting down...");
  stopMonitor();
  closeDb();
  process.exit(0);
});

main().catch(err => {
  console.error("[PriceAlert] Fatal error:", err);
  process.exit(1);
});
