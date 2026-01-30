
// === YOPO TUNING (AUTO) ===
const CHAOS_HOLD_BOOST = 1.35;   // HOLD 비중 상향
const REGIME_SENSITIVITY = 0.85; // 레짐 민감도 완화
const EV_EDGE_WEIGHT = 0.75;     // EV에서 edge 비중 상향


// FIXED algo_core.js — tuning patch only
const CHAOS_HOLD_BOOST = 1.35;   // HOLD 비중 상향
const REGIME_SENSITIVITY = 0.85; // 레짐 민감도 완화
const EV_EDGE_WEIGHT = 0.75;     // EV에서 edge 비중 상향


/* === SAFE EXPORT WRAPPER === */
export function predict(input){
  try{
    if(typeof corePredict === 'function'){
      return corePredict(input);
    }
    return { action: "HOLD", reason: "CORE_PREDICT_NOT_FOUND" };
  }catch(e){
    return { action: "HOLD", reason: "CORE_ERROR", error: String(e) };
  }
}
