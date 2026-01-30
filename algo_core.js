/*************************************************************
 * YOPO AI PRO — algo_core.js (FULL)
 * - Regime (6) + Experts gating + Reality filter + EV 선택
 * - ✅ FIX 2026-01-30:
 *   - tp/sl 1% 고정 제거 → TF/변동성 기반 동적 tp/sl
 *   - output에 tpPct/slPct/tp/sl/edge/winProb 포함
 *************************************************************/

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

  // proxy ATR% (very light)
  const atrPct = clamp(range * 100, 0.05, 20);

  return { vol, trend, range, breakoutUp, breakoutDn, dev, atrPct };
}

export function detectRegime(candles){
  const f = computeCoreFeatures(candles);
  const t = f.trend, v=f.vol, d=f.dev;

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

  return { long: clamp(long,0,1), short: clamp(short,0,1) };
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
function computeEV(p, tpPct, slPct){
  const q = 1-p;
  return (p*tpPct) - (q*slPct);
}

// TF -> base scaling
function tfScale(tf){
  const t = String(tf||"").toLowerCase();
  if(t==="15m") return 0.90;
  if(t==="30m") return 1.05;
  if(t==="1h")  return 1.20;
  if(t==="4h")  return 1.55;
  if(t==="1d")  return 1.95;
  if(t==="1w")  return 2.60;
  return 1.20;
}

/**
 * ✅ Dynamic TP/SL (pct)
 * - tpPct: 최소 1% 유지(지침), 변동성/TF에 따라 증가
 * - slPct: RR 기반 (기본 1.8~2.2)
 */
function computeDynamicTpSlPct(tf, regime, f){
  const scale = tfScale(tf);

  // base from atr proxy
  const atrPct = clamp(Number(f?.atrPct || 0.8), 0.20, 12.0); // %
  let tpPct = atrPct * 0.55 * scale; // %
  tpPct = clamp(tpPct, 1.00, 8.00); // % (지침: 1% 미만 금지)

  // regime RR
  let rr = 1.90;
  if(regime==="TREND_UP" || regime==="TREND_DOWN") rr = 2.10;
  if(regime==="BREAKOUT") rr = 2.20;
  if(regime==="MEAN_REVERT") rr = 1.75;
  if(regime==="RANGE") rr = 1.85;

  // chaos는 hold라 여기까지 오지 않지만 안전
  rr = clamp(rr, 1.45, 2.40);

  const slPct = clamp(tpPct / rr, 0.40, 6.00);

  return { tpPct, slPct, rr };
}

function priceFromPct(entry, action, tpPct, slPct){
  const e = Number(entry);
  if(!Number.isFinite(e) || e<=0) return { tp:null, sl:null };
  const tp = (action==="LONG") ? e*(1 + tpPct/100) : e*(1 - tpPct/100);
  const sl = (action==="LONG") ? e*(1 - slPct/100) : e*(1 + slPct/100);
  return { tp, sl };
}

/**
 * Main prediction
 * input:
 *  { symbol, tf, candles, tpPct?, slPct? }
 */
export function predict(input){
  try{
    const candles = input?.candles || [];
    if(candles.length < 60){
      return { ok:true, action:"HOLD", reason:"NOT_ENOUGH_CANDLES" };
    }

    const tf = String(input?.tf || "1h");
    const regime = detectRegime(candles);
    const f = computeCoreFeatures(candles);

    const lastClose = Number(candles[candles.length-1]?.close);
    const entry = Number.isFinite(lastClose) ? lastClose : null;

    // reality filter
    if(realityHold(candles)){
      return {
        ok:true, action:"HOLD", regime, reason:"REALITY_FILTER",
        entry,
        pLong:0.5, pShort:0.5, winProb:0.5, edge:0
      };
    }

    // CHAOS -> boost HOLD
    if(regime==="CHAOS"){
      const holdBias = clamp(0.5*CHAOS_HOLD_BOOST, 0.5, 0.85);
      return {
        ok:true, action:"HOLD", regime, reason:"CHAOS", holdBias,
        entry,
        pLong:0.5, pShort:0.5, winProb:0.5, edge:0
      };
    }

    const exp = experts(regime, f);

    // ✅ tp/sl 입력이 없으면 동적 계산
    let tpPct = Number(input?.tpPct);
    let slPct = Number(input?.slPct);
    let rr = null;
    if(!Number.isFinite(tpPct) || !Number.isFinite(slPct) || tpPct<=0 || slPct<=0){
      const dyn = computeDynamicTpSlPct(tf, regime, f);
      tpPct = dyn.tpPct;
      slPct = dyn.slPct;
      rr = dyn.rr;
    }

    // profit threshold: <1% skip (지침)
    if(tpPct < 1.0){
      return { ok:true, action:"HOLD", regime, reason:"TP_LT_1PCT", entry, tpPct, slPct };
    }

    const pLong = clamp(exp.long, 0, 1);
    const pShort = clamp(exp.short, 0, 1);
    const winProb = Math.max(pLong, pShort);
    const edge = clamp(Math.abs(pLong - pShort), 0, 1);

    const evLong  = computeEV(pLong,  (tpPct/100), (slPct/100));
    const evShort = computeEV(pShort, (tpPct/100), (slPct/100));

    if(evLong <= 0 && evShort <= 0){
      return {
        ok:true, action:"HOLD", regime, reason:"NEGATIVE_EV",
        entry, tpPct, slPct, rr,
        pLong, pShort, winProb, edge,
        evLong, evShort
      };
    }

    const action = (evLong >= evShort) ? "LONG" : "SHORT";
    const prices = priceFromPct(entry, action, tpPct, slPct);

    return {
      ok:true,
      action,
      regime,
      reason: "EV_SELECT",
      entry,
      tpPct, slPct, rr,
      tp: prices.tp,
      sl: prices.sl,
      pLong,
      pShort,
      winProb,
      edge,
      evLong,
      evShort
    };
  }catch(e){
    return { ok:true, action:"HOLD", reason:"CORE_ERROR", error: String(e) };
  }
}
