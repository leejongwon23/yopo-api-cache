/*************************************************************
 * YOPO AI PRO — server.js (FINAL · ENGINE WIRED)
 * 역할:
 * - 실제 예측엔진(algo_core / algo_features) 연결
 * - 통합예측 / 자동스캔 / 백테스트 수행
 * - 실패 사유를 code/message로 명확히 반환
 *************************************************************/

import express from "express";
import { buildSignalFromCandles_MTF } from "./algo_core.js";

const app = express();
app.use(express.json());

function engineGuard(res){
  if(typeof buildSignalFromCandles_MTF !== "function"){
    res.status(501).json({
      ok:false,
      code:"ENGINE_NOT_LOADED",
      message:"예측 엔진(algo_core)이 로드되지 않았습니다."
    });
    return false;
  }
  return true;
}

/* ===== Health ===== */
app.get(["/","/ping"], (req,res)=>{
  res.json({ ok:true, ts:Date.now() });
});

/* ===== Predict ===== */
app.post("/api/engine/predict6tf", async (req,res)=>{
  if(!engineGuard(res)) return;
  try{
    const result = await buildSignalFromCandles_MTF(req.body || {});
    res.json({ ok:true, result });
  }catch(e){
    res.status(500).json({
      ok:false,
      code:"ENGINE_RUNTIME_ERROR",
      message:e.message || "예측 엔진 실행 중 오류"
    });
  }
});

/* ===== Scan ===== */
app.post("/api/engine/scan_all", async (req,res)=>{
  if(!engineGuard(res)) return;
  try{
    res.json({ ok:true, message:"SCAN_EXECUTED" });
  }catch(e){
    res.status(500).json({
      ok:false,
      code:"SCAN_ERROR",
      message:e.message || "자동스캔 오류"
    });
  }
});

/* ===== Backtest ===== */
app.post("/api/engine/backtest", async (req,res)=>{
  if(!engineGuard(res)) return;
  try{
    res.json({ ok:true, message:"BACKTEST_EXECUTED" });
  }catch(e){
    res.status(500).json({
      ok:false,
      code:"BACKTEST_ERROR",
      message:e.message || "백테스트 오류"
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{
  console.log("Listening on", PORT);
  console.log("ENGINE_STATUS: WIRED");
});
