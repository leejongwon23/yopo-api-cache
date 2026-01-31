/*************************************************************
 * YOPO AI PRO — algo_core.js (FULL)
 * - Regime (6) + Experts gating + Reality filter + EV 선택
 *************************************************************/
import { computeFeatures } from "./algo_features.js";

// === YOPO TUNING (AUTO) ===
const CHAOS_HOLD_BOOST = 1.35;   // HOLD 비중 상향
const REGIME_SENSITIVITY = 0.85; // 레짐 민감도 완화
const EV_EDGE_WEIGHT = 0.75;     // EV edge 가중

const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));
const mean = (arr)=>arr.reduce((s,x)=>s+x,0)/(arr.length||1);

function pct(a,b){ return (b-a)/a; }

// Basic features from candles: [{open,high,low,close,volume,ts}...]
function computeCoreFeatures(candles){
  const n = candles.length;
  const closes = candles.map(c=>c.close);
  const highs = candles.map(c=>c.high);
  const lows  = candles.map(c=>c.low);
  const rets = [];
  for(let i=1;i<n;i++) rets.push((closes[i]-closes[i-1])/closes[i-1]);
  const vol = Math.sqrt(mean(rets.map(r=>r*r)) || 0);
  const trend = (closes[n-1]-closes[0]) / closes[0];
  const range = (Math.max(...highs)-Math.min(...lows)) / closes[n-1];
  // breakout score: last close vs recent high/low
  const look = Math.min(30, n-1);
  const recentHigh = Math.max(...highs.slice(n-look));
  const recentLow  = Math.min(...lows.slice(n-look));
  const last = closes[n-1];
  const breakoutUp = (last - recentHigh)/last;
  const breakoutDn = (recentLow - last)/last;
  // mean revert proxy: distance from mean
  const m = mean(closes.slice(n-look));
  const dev = (last - m)/m;
  return {
    meta: { features: _feats }, vol, trend, range, breakoutUp, breakoutDn, dev };
}

export function detectRegime(candles){
  const f = computeCoreFeatures(candles);
  const t = f.trend, v=f.vol, r=f.range, d=f.dev;

  // CHAOS: volatility high OR whipsaw proxy (high vol + low trend)
  if(v > 0.02*REGIME_SENSITIVITY && Math.abs(t) < 0.01) return "CHAOS";

  // BREAKOUT: last close breaking recent bounds
  if(f.breakoutUp > 0.002) return "BREAKOUT";
  if(f.breakoutDn > 0.002) return "BREAKOUT";

  // TREND up/down
  if(t > 0.015*REGIME_SENSITIVITY && v < 0.03) return "TREND_UP";
  if(t < -0.015*REGIME_SENSITIVITY && v < 0.03) return "TREND_DOWN";

  // MEAN_REVERT: strong deviation but not trending
  if(Math.abs(d) > 0.01 && Math.abs(t) < 0.01) return "MEAN_REVERT";

  return "RANGE";
}

// Experts: return score for LONG/SHORT in [0,1]
function experts(regime, f){
  // base scores from simple heuristics
  let long=0.5, short=0.5;

  if(regime==="TREND_UP"){ long = 0.65; short=0.35; }
  if(regime==="TREND_DOWN"){ long = 0.35; short=0.65; }
  if(regime==="RANGE"){ long = 0.50; short=0.50; }
  if(regime==="BREAKOUT"){
    // direction based on breakout indicators
    if(f.breakoutUp>0) { long=0.62; short=0.38; }
    else { long=0.38; short=0.62; }
  }
  if(regime==="MEAN_REVERT"){
    // fade deviation
    if(f.dev>0) { short=0.60; long=0.40; } else { long=0.60; short=0.40; }
  }
  if(regime==="CHAOS"){
    // prefer HOLD; keep both near 0.5
    long = 0.5; short=0.5;
  }

  // volatility adjustment: high vol -> reduce confidence
  const damp = clamp(1 - f.vol*10, 0.2, 1.0);
  long = 0.5 + (long-0.5)*damp;
  short = 0.5 + (short-0.5)*damp;

  return {
    meta: { features: _feats }, long: clamp(long,0,1), short: clamp(short,0,1) };
}

// Reality filter: return true if should HOLD
function realityHold(candles){
  const n = candles.length;
  const f = computeCoreFeatures(candles);
  // volatility spike
  if(f.vol > 0.03) return true;
  // box edge proximity: last close near recent high/low
  const look = Math.min(20, n-1);
  const highs = candles.map(c=>c.high);
  const lows = candles.map(c=>c.low);
  const recentHigh = Math.max(...highs.slice(n-look));
  const recentLow = Math.min(...lows.slice(n-look));
  const last = candles[n-1].close;
  if(Math.abs((recentHigh-last)/last) < 0.002) return true;
  if(Math.abs((last-recentLow)/last) < 0.002) return true;
  // whipsaw: sign changes in last returns
  let flips=0;
  for(let i=n-10;i<n-1;i++){
    if(i<=0) continue;
    const r1 = pct(candles[i-1].close, candles[i].close);
    const r2 = pct(candles[i].close, candles[i+1].close);
    if(Math.sign(r1)!==Math.sign(r2)) flips++;
  }
  if(flips>=6) return true;
  return false;
}

// EV calculation using expected move (tp/sl as pct)
function computeEV(p, tp, sl){
  const q = 1-p;
  return (p*tp) - (q*sl);
}

/**
 * Main prediction
 * input:
 *  { symbol, tf, candles, tp, sl, memoryStats? }
 */
export function predict(input){
  const _feats = computeFeatures(candles);
  try{
    const candles = input?.candles || [];
    if(candles.length < 60){
      return {
    meta: { features: _feats }, ok:true, action:"HOLD", reason:"NOT_ENOUGH_CANDLES" };
    }

    const regime = detectRegime(candles);
    const f = computeCoreFeatures(candles);

    // reality filter
    if(realityHold(candles)){
      return {
    meta: { features: _feats }, ok:true, action:"HOLD", regime, reason:"REALITY_FILTER" };
    }

    const exp = experts(regime, f);

    // CHAOS -> boost HOLD
    if(regime==="CHAOS"){
      const holdBias = clamp(0.5*CHAOS_HOLD_BOOST, 0.5, 0.85);
      return {
    meta: { features: _feats }, ok:true, action:"HOLD", regime, reason:"CHAOS", holdBias };
    }

    const tp = input?.tp ?? 0.01;
    const sl = input?.sl ?? 0.01;

    const evLong  = computeEV(exp.long,  tp*EV_EDGE_WEIGHT + tp*(1-EV_EDGE_WEIGHT), sl);
    const evShort = computeEV(exp.short, tp*EV_EDGE_WEIGHT + tp*(1-EV_EDGE_WEIGHT), sl);

    // profit threshold: <1% skip
    if(tp < 0.01) return { ok:true, action:"HOLD", regime, reason:"TP_LT_1PCT" };

    if(evLong <= 0 && evShort <= 0){
      return {
    meta: { features: _feats }, ok:true, action:"HOLD", regime, reason:"NEGATIVE_EV", evLong, evShort, pLong:exp.long, pShort:exp.short };
    }

    const action = (evLong >= evShort) ? "LONG" : "SHORT";
    return {
    meta: { features: _feats },
      ok:true,
      action,
      regime,
      pLong: exp.long,
      pShort: exp.short,
      evLong,
      evShort,
      reason: "EV_SELECT"
    };
  }catch(e){
    return {
    meta: { features: _feats }, ok:true, action:"HOLD", reason:"CORE_ERROR", error: String(e) };
  }
}
