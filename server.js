
/*************************************************************
 * YOPO AI PRO — server.js (FIXED · FULL · RENDER-SAFE)
 *************************************************************/

import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   Middleware
========================= */
app.use(cors());
app.use(express.json());

/* =========================
   Health Check
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, service: "YOPO AI PRO API", status: "running" });
});

app.get("/ping", (req, res) => {
  res.send("pong");
});

/* =========================
   Engine APIs (placeholders wired)
========================= */
app.post("/api/engine/predict6tf", (req, res) => {
  const { symbol } = req.body || {};
  res.json({
    ok: true,
    action: "HOLD",
    symbol: symbol || "BTCUSDT",
    reason: "ENGINE_PLACEHOLDER"
  });
});

app.post("/api/engine/scan_all", (req, res) => {
  res.json({
    ok: true,
    results: [],
    reason: "ENGINE_PLACEHOLDER"
  });
});

app.post("/api/engine/backtest", (req, res) => {
  res.json({
    ok: true,
    stats: { trades: 0, winRate: 0 },
    reason: "ENGINE_PLACEHOLDER"
  });
});

/* =========================
   Evolve APIs (safe stubs)
========================= */
app.post("/api/evolve/feedback", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/evolve/stats", (req, res) => {
  res.json({ ok: true, totalEvents: 0 });
});

/* =========================
   Start Server
========================= */
app.listen(PORT, () => {
  console.log(`[YOPO] Server running on port ${PORT}`);
});
