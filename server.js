
/*************************************************************
 * YOPO AI PRO — server.js (NEW · CLEAN · RENDER-SAFE)
 * 역할:
 * - Express 서버 부트
 * - 엔진 API 제공 (predict6tf / scan_all / backtest)
 * - 헬스체크 (/ , /ping)
 * - app.api.js 와 100% 호환
 *************************************************************/

import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   Middleware
========================= */
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
   Engine APIs
   (현재는 엔진 연결 전 최소 정상 응답 구조)
========================= */

// 통합 예측 (6 TF)
app.post("/api/engine/predict6tf", (req, res) => {
  const { symbol } = req.body || {};
  res.json({
    ok: true,
    type: "HOLD",
    symbol: symbol || "BTCUSDT",
    message: "predict6tf engine placeholder (server alive)"
  });
});

// 자동 스캔 (20 코인)
app.post("/api/engine/scan_all", (req, res) => {
  res.json({
    ok: true,
    results: [],
    message: "scan_all engine placeholder (server alive)"
  });
});

// 백테스트
app.post("/api/engine/backtest", (req, res) => {
  res.json({
    ok: true,
    stats: {
      trades: 0,
      winRate: 0
    },
    message: "backtest engine placeholder (server alive)"
  });
});

/* =========================
   Start Server
========================= */
app.listen(PORT, () => {
  console.log(`[YOPO] Server running on port ${PORT}`);
});
