/*************************************************************
 * YOPO AI PRO — app.core.js (분할 v1+)
 * 역할: 공용 상수/전역상태(state)/저장/유틸/토스트/시간계산/지표/유사도/신호코어
 * 주의:
 * - index.html onclick 바인딩(window.xxx=...)은 app.features.js에서 최종 처리
 * - 이 파일은 “공용 기반(상태/규칙/초기화/계산)”을 제공한다.
 *************************************************************/

/* =========================
   AUTH
========================= */
const AUTH_PASSWORD = "2580";
const AUTH_KEY = "yopo_auth_ok_v1"; // localStorage key

function isAuthed(){
  try{ return localStorage.getItem(AUTH_KEY) === "1"; }catch(e){ return false; }
}
function showAuth(){
  document.getElementById("auth-overlay").style.display = "flex";
  document.getElementById("app").style.display = "none";
  setTimeout(()=>{ document.getElementById("auth-input")?.focus(); }, 50);
}
function hideAuth(){
  document.getElementById("auth-overlay").style.display = "none";
  document.getElementById("app").style.display = "flex";
}
function tryAuth(){
  const input = document.getElementById("auth-input");
  const err = document.getElementById("auth-err");
  if(!input) return;
  const v = String(input.value || "").trim();
  if(v === AUTH_PASSWORD){
    try{ localStorage.setItem(AUTH_KEY, "1"); }catch(e){}
    if(err) err.style.display = "none";
    hideAuth();
  }else{
    if(err) err.style.display = "block";
    input.value = "";
    input.focus();
  }
}

/* =========================
   Storage
========================= */
const STORAGE_KEY = "yopo_single_v6_state";

function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }catch(e){}
}
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}

/* =========================
   API constants (URL만)
========================= */
const BYBIT_TICKERS = "https://api.bybit.com/v5/market/tickers?category=linear";
const BYBIT_KLINE = (symbol, interval, limit) =>
  `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;

const CG_MARKETS = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false&price_change_percentage=24h";
const CG_GLOBAL  = "https://api.coingecko.com/api/v3/global";

/* =========================
   Similarity / Analysis Params
========================= */
const SIM_WINDOW = 40;
const FUTURE_H = 8;     // ✅ “평가 기간”에 사용 (유사패턴 미래 비교용)  ※ 카운트다운에는 사용 금지
const SIM_STEP = 2;
const SIM_TOPK = 25;

// HOLD rules
const HOLD_MIN_TOPK = 12;
const HOLD_MIN_SIM_AVG = 55;
const HOLD_MIN_EDGE = 0.08;
const HOLD_MIN_TP_PCT = 0.8;

// ✅ MTF 합의 기준
const MTF_WEIGHTS_3TF = { "60": 0.50, "240": 0.30, "D": 0.20 }; // 분석(정밀): 3TF
const MTF_WEIGHTS_2TF = { "base": 0.65, "other": 0.35 };       // 스캔/백테스트(속도): 2TF
const MTF_MIN_AGREE = 2;           // 3TF 중 최소 2개는 같은 방향이어야 안정
const MTF_DISAGREE_PENALTY = 0.06; // 합의 부족이면 edge를 살짝 깎아 더 보수적(HOLD 증가)

// TP/SL
const RR = 2.0;
const TF_MULT = { "60": 1.2, "240": 2.0, "D": 3.5 };
const ATR_MIN_PCT = 0.15;
const TP_MAX_PCT = 20.0;

// ✅ UPGRADE ②: 확신도 기반 TP/SL 미세 조정
const CONF_TIER_HIGH = { winProb: 0.66, edge: 0.13 };
const CONF_TIER_MID  = { winProb: 0.60, edge: 0.10 };
const CONF_TP_SCALE  = { HIGH: 1.10, MID: 1.00, LOW: 0.88 };
const CONF_RR_VALUE  = { HIGH: 2.20, MID: 1.90, LOW: 1.45 };
const CONF_EDGE_FLOOR = 0.04;

// ✅ UPGRADE ③: TIME 종료 판정 고도화(MFE 반영)
const TIME_MFE_MIN_PCT = 0.45;
const TIME_MFE_TP_RATIO = 0.55;

// cooldown
const COOLDOWN_MS = { "60": 10 * 60 * 1000, "240": 30 * 60 * 1000, "D": 2 * 60 * 60 * 1000 };

// scan delay
const SCAN_DELAY_MS = 650;

// backtest
const BACKTEST_TRADES = 80;
const EXTENDED_LIMIT = 900;

// 백테스트 필터(잡신호 제거용)
const BT_MIN_PROB = 0.58;
const BT_MIN_EDGE = 0.10;
const BT_MIN_SIM  = 60;

/* ==========================================================
   ✅ ADD (2026-01-22E) 근본 업그레이드: 레짐/최근가중/실전보정/변동성/트레일링/수수료
   ========================================================== */

// 1) 레짐(추세) 필터
const REGIME_MIN_STRENGTH_BY_TF = { "60": 0.55, "240": 0.50, "D": 0.45 };

// 2) 유사도 최근가중치
const SIM_RECENCY_HALFLIFE_STEPS = 140;

// 2-추가) 최근 성과 캘리브레이션
const RECENT_CALIB_N = 20;
const RECENT_CALIB_ALPHA = 0.15;

// 3) 변동성 위험 필터
const VOL_MAX_ATR_PCT_BY_TF = { "60": 2.20, "240": 3.10, "D": 4.60 };

// 4) 브레이크이븐/트레일링
const BE_TRIGGER_PCT = 0.65;
const BE_OFFSET_PCT  = 0.06;
const TRAIL_START_PCT = 1.10;
const TRAIL_GAP_PCT   = 0.55;

// 5) 비용(수수료+슬리피지)
const FEE_PCT = 0.12; // % 단위

/* ==========================================================
   ✅ NEW: 실패 패턴 엔진 (핵심 변경: "차단" → "패널티")
   ========================================================== */
const PATTERN_DB_VERSION = 1;
const PATTERN_MIN_SAMPLES = 14;       // 통계로 쓸 최소 표본
const PATTERN_BAD_WINRATE = 0.48;     // 이하면 "나쁜 패턴"
const PATTERN_MAX_AVOID = 120;        // avoid 리스트 상한
const PATTERN_BIN = {
  atrPct: 0.50,
  trendStrength: 0.10,
  edge: 0.02,
  simAvg: 5,
  dom: 1.0
};

// ✅ 핵심: 예측을 줄이지 않기 위한 "감점" 파라미터
const PATTERN_PENALTY_MAX = 0.12;     // winProb 최대 감점(0~0.12)
const PATTERN_PENALTY_EDGE_W = 0.70;  // edge 감점 비중
const PATTERN_HARD_HOLD_WR = 0.34;    // 정말 최악일 때만 HOLD
const PATTERN_HARD_HOLD_N  = 28;      // 표본도 충분할 때만

function ensurePatternDB(){
  if(!state.patternDB || typeof state.patternDB !== "object"){
    state.patternDB = { v: PATTERN_DB_VERSION, stats: {}, avoid: {} };
    saveState();
    return;
  }
  if(state.patternDB.v !== PATTERN_DB_VERSION){
    state.patternDB = { v: PATTERN_DB_VERSION, stats: {}, avoid: {} };
    saveState();
    return;
  }
  if(!state.patternDB.stats || typeof state.patternDB.stats !== "object") state.patternDB.stats = {};
  if(!state.patternDB.avoid || typeof state.patternDB.avoid !== "object") state.patternDB.avoid = {};
}

function _bin(x, step){
  const v = Number.isFinite(x) ? x : 0;
  const s = Math.max(step, 1e-9);
  return Math.max(0, Math.floor(v / s));
}

function buildPatternSignature(symbol, tfRaw, type, ex){
  const atrB = _bin(ex?.atrPct ?? 0, PATTERN_BIN.atrPct);
  const tsB  = _bin(ex?.trendStrength ?? 0, PATTERN_BIN.trendStrength);
  const eB   = _bin(ex?.edge ?? 0, PATTERN_BIN.edge);
  const sB   = _bin(ex?.simAvg ?? 0, PATTERN_BIN.simAvg);
  const mA   = Number.isFinite(ex?.mtf?.agree) ? ex.mtf.agree : 1;
  const cT   = (ex?.conf?.tier) ? String(ex.conf.tier) : "NA";

  const dom = (typeof ex?.btcDom === "number") ? ex.btcDom : null;
  const domB = dom === null ? "X" : String(_bin(dom, PATTERN_BIN.dom));
  const domUp = (typeof ex?.btcDomUp === "number") ? ex.btcDomUp : 0;
  const domU = domUp > 0.10 ? "UP" : domUp < -0.10 ? "DN" : "FL";

  return `${symbol}|${tfRaw}|${type}|A${atrB}|T${tsB}|E${eB}|S${sB}|M${mA}|C${cT}|D${domB}|U${domU}`;
}

function recordPatternOutcome(signature, win){
  ensurePatternDB();
  if(!signature) return;

  const stats = state.patternDB.stats;
  const cur = stats[signature] || { n: 0, win: 0 };
  cur.n += 1;
  if(win) cur.win += 1;
  stats[signature] = cur;

  const wr = cur.n > 0 ? (cur.win / cur.n) : 1;
  if(cur.n >= PATTERN_MIN_SAMPLES && wr <= PATTERN_BAD_WINRATE){
    state.patternDB.avoid[signature] = { n: cur.n, wr: wr };
  }else{
    if(state.patternDB.avoid[signature]) delete state.patternDB.avoid[signature];
  }

  const keys = Object.keys(state.patternDB.avoid);
  if(keys.length > PATTERN_MAX_AVOID){
    keys.sort((a,b)=> (state.patternDB.avoid[a]?.n ?? 0) - (state.patternDB.avoid[b]?.n ?? 0));
    const trim = keys.length - PATTERN_MAX_AVOID;
    for(let i=0;i<trim;i++){
      delete state.patternDB.avoid[keys[i]];
    }
  }

  saveState();
}

function getAvoidMeta(signature){
  ensurePatternDB();
  return state.patternDB.avoid?.[signature] || null;
}

function computePatternPenalty(meta){
  if(!meta) return { penalty: 0, hardHold: false };

  const n = Number(meta.n || 0);
  const wr = Number(meta.wr || 1);

  const bad = clamp((PATTERN_BAD_WINRATE - wr) / Math.max(PATTERN_BAD_WINRATE, 1e-9), 0, 1);
  const nW = clamp((n - PATTERN_MIN_SAMPLES) / 30, 0, 1);

  const penalty = clamp(PATTERN_PENALTY_MAX * bad * (0.45 + 0.55 * nW), 0, PATTERN_PENALTY_MAX);
  const hardHold = (n >= PATTERN_HARD_HOLD_N && wr <= PATTERN_HARD_HOLD_WR);

  return { penalty, hardHold };
}

/* ==========================================================
   ✅ NEW: "통합예측(단/중/장)" 합의 규칙
   ========================================================== */
function consensusAll3Signals(sig60, sig240, sigD){
  const sigs = [
    { tfRaw:"60",  sig:sig60 },
    { tfRaw:"240", sig:sig240 },
    { tfRaw:"D",   sig:sigD }
  ];

  // 방향표(홀드 제외)
  let longN = 0, shortN = 0;
  for(const x of sigs){
    const t = x?.sig?.type;
    if(t === "LONG") longN++;
    if(t === "SHORT") shortN++;
  }

  let finalType = "HOLD";
  if(longN >= 2) finalType = "LONG";
  else if(shortN >= 2) finalType = "SHORT";
  else finalType = "HOLD";

  // 통합 확률/엣지(간단 평균 + 합의 가중)
  let wp = 0, ed = 0, cnt = 0;
  for(const x of sigs){
    if(!x.sig || !x.sig.explain) continue;
    const ex = x.sig.explain;
    if(Number.isFinite(ex.winProb)) wp += ex.winProb;
    if(Number.isFinite(ex.edge)) ed += ex.edge;
    cnt++;
  }
  wp = cnt ? (wp / cnt) : 0.5;
  ed = cnt ? (ed / cnt) : 0;

  const agree = Math.max(longN, shortN); // 0~3
  const wpAdj = clamp(wp + (agree >= 2 ? 0.01 : 0), 0.5, 0.99);

  return {
    finalType,
    agree,
    longN,
    shortN,
    winProbAvg: wpAdj,
    edgeAvg: ed,
    detail: {
      "60": sig60,
      "240": sig240,
      "D": sigD
    }
  };
}


/* ==========================================================
   ✅ BRAIN UPGRADE v4: META BRAIN (경험 학습)
   - 예측이 끝날 때마다 (TP/SL 기준) 결과를 저장
   - 다음 예측에서 '비슷한 상황'의 승률을 보정에 활용
   - ❌ 예측을 줄이는 필터가 아니라, ✅ 뇌의 선택/확률을 더 똑똑하게 만드는 구조
   ========================================================== */
const META_BRAIN_VERSION = 1;
const META_MIN_SAMPLES = 12;      // 이 이상부터 의미있게 반영
const META_PRIOR_N = 18;          // 베이지안 완충(초기 흔들림 방지)
const META_PRIOR_WR = 0.55;       // 초기 기대 승률
const META_ALPHA_MAX = 0.18;      // winProb 보정 최대치(과대반영 방지)

function ensureMetaBrain(){
  if(!state.metaBrain || typeof state.metaBrain !== "object"){
    state.metaBrain = { v: META_BRAIN_VERSION, stats: {} };
    saveState();
    return;
  }
  if(state.metaBrain.v !== META_BRAIN_VERSION){
    state.metaBrain = { v: META_BRAIN_VERSION, stats: {} };
    saveState();
    return;
  }
  if(!state.metaBrain.stats || typeof state.metaBrain.stats !== "object") state.metaBrain.stats = {};
}

// feature bin helper (단순/안정)
function _mbin(x, step, min=-9999, max=9999){
  const v = Number.isFinite(x) ? x : 0;
  const s = Math.max(step, 1e-9);
  const b = Math.floor(v / s);
  return Math.max(min, Math.min(max, b));
}

function buildMetaKey(symbol, tfRaw, type, regime, ex){
  // 너무 세밀하면 표본이 쪼개지므로 "굵게" 묶는다.
  const atrB = _mbin(ex?.atrPct ?? 0, 0.6, -50, 50);
  const tsB  = _mbin(ex?.trendStrength ?? 0, 0.25, -50, 50);
  const adxB = _mbin(ex?.adx ?? 0, 5.0, -50, 50);
  const bwB  = _mbin((ex?.bbWidth ?? 0)*100, 2.0, -50, 50);
  const vspB = _mbin(ex?.volSpike ?? 0, 0.25, -50, 50);
  const domB = _mbin(ex?.btcDomUp ?? 0, 0.2, -50, 50);

  return [
    symbol, tfRaw, type,
    (regime || "UNK"),
    `a${atrB}`, `t${tsB}`, `x${adxB}`, `b${bwB}`, `v${vspB}`, `d${domB}`
  ].join("|");
}

function metaGetStats(key){
  ensureMetaBrain();
  return state.metaBrain.stats[key] || null;
}

function metaGetWinRate(key){
  const s = metaGetStats(key);
  if(!s) return null;
  const n = Number(s.n || 0);
  const w = Number(s.w || 0);
  if(n <= 0) return null;
  // 베이지안 스무딩
  const wr = (w + META_PRIOR_WR*META_PRIOR_N) / (n + META_PRIOR_N);
  return { wr, n, w };
}

function metaUpdate(key, win){
  ensureMetaBrain();
  if(!key) return;
  const s = state.metaBrain.stats[key] || { n: 0, w: 0 };
  s.n += 1;
  if(win) s.w += 1;
  state.metaBrain.stats[key] = s;
  saveState();
}

// 포지션이 종료될 때 features.js에서 호출
function metaRecordFromPosition(pos, win, reason){
  try{
    const ex = pos?.explain || {};
    const key = ex?.metaKey || null;
    if(!key) return;
    // 성공 정의(B): TP가 먼저 닿으면 성공, SL이 먼저 닿으면 실패
    // TIME 종료는 '불완전'이라 메타 학습에 약하게만 반영(또는 제외)
    if(reason === "TP" || reason === "SL"){
      metaUpdate(key, !!win);
    }else{
      // TIME 기반은 너무 noisy: 0.35 가중치로만 반영(정수만 저장되므로 1회 중 1회만 반영)
      // 간단히: TIME은 기록하지 않음(안전)
    }
  }catch(e){}
}

function applyMetaAdjustment(winProb, key){
  const m = metaGetWinRate(key);
  if(!m) return { winProb, meta: null };

  const n = m.n;
  if(n < META_MIN_SAMPLES) return { winProb, meta: { ...m, alpha: 0 } };

  // 샘플이 쌓일수록 alpha ↑ (최대 META_ALPHA_MAX)
  const alpha = Math.min(META_ALPHA_MAX, (n - META_MIN_SAMPLES) / 80 * META_ALPHA_MAX);
  const adj = clamp((1-alpha)*winProb + alpha*m.wr, 0.50, 0.99);
  return { winProb: adj, meta: { ...m, alpha } };
}


function scoreUnifiedSignal(unified){
  const w = Number(unified?.winProbAvg ?? 0);
  const e = Number(unified?.edgeAvg ?? 0);
  const agree = Number(unified?.agree ?? 0);
  const bonus = (agree >= 2) ? 0.02 : 0;
  return (w * 1.0) + (e * 0.7) + bonus;
}

/* =========================
   Candidate List (30)
   - cg는 확실한 것만 유지 (불확실한 매핑은 생략)
========================= */
const DEFAULT_CANDIDATES = [
  { s:"BTCUSDT", n:"Bitcoin" },
  { s:"ETHUSDT", n:"Ethereum" },
  { s:"BNBUSDT", n:"BNB" },
  { s:"SOLUSDT", n:"Solana" },
  { s:"XRPUSDT", n:"XRP" },
  { s:"ADAUSDT", n:"Cardano" },
  { s:"DOGEUSDT", n:"Dogecoin" },
  { s:"TRXUSDT", n:"TRON" },
  { s:"TONUSDT", n:"Toncoin" },
  { s:"AVAXUSDT", n:"Avalanche" },
  { s:"LINKUSDT", n:"Chainlink" },
  { s:"DOTUSDT", n:"Polkadot" },
  { s:"MATICUSDT", n:"Polygon" },
  { s:"LTCUSDT", n:"Litecoin" },
  { s:"BCHUSDT", n:"Bitcoin Cash" },
  { s:"UNIUSDT", n:"Uniswap" },
  { s:"ATOMUSDT", n:"Cosmos" },
  { s:"ETCUSDT", n:"Ethereum Classic" },
  { s:"XLMUSDT", n:"Stellar" },
  { s:"FILUSDT", n:"Filecoin" },
  { s:"APTUSDT", n:"Aptos" },
  { s:"NEARUSDT", n:"NEAR" },
  { s:"OPUSDT", n:"Optimism" },
  { s:"ARBUSDT", n:"Arbitrum" },
  { s:"SUIUSDT", n:"Sui" },
  { s:"ICPUSDT", n:"Internet Computer" },
  { s:"INJUSDT", n:"Injective" },
  { s:"RNDRUSDT", n:"Render" },
  { s:"SHIBUSDT", n:"Shiba Inu" },
  { s:"PEPEUSDT", n:"Pepe" }
];


// ✅ Universe 정규화(항상 30종으로 고정)
// - 로컬스토리지에 예전 60종이 남아있어도, 여기서 30으로 강제 동기화한다.
const UNIVERSE_TARGET_LIMIT = 30;
function normalizeUniverse(list){
  try{
    const arr = Array.isArray(list) ? list : [];
    const seen = new Set();
    const out = [];
    for(const x of arr){
      const s = String(x?.s || x?.symbol || "").toUpperCase();
      if(!s || !s.endsWith("USDT")) continue;
      if(seen.has(s)) continue;
      seen.add(s);
      out.push({ s, n: x?.n || x?.name || s.replace("USDT","") });
      if(out.length >= UNIVERSE_TARGET_LIMIT) break;
    }
    // 부족하면 DEFAULT로 채움
    if(out.length < UNIVERSE_TARGET_LIMIT){
      for(const d of DEFAULT_CANDIDATES){
        const s = String(d.s).toUpperCase();
        if(seen.has(s)) continue;
        seen.add(s);
        out.push({ s, n: d.n });
        if(out.length >= UNIVERSE_TARGET_LIMIT) break;
      }
    }
    // 그래도 0이면 DEFAULT 그대로
    if(out.length === 0) return DEFAULT_CANDIDATES.slice(0, UNIVERSE_TARGET_LIMIT);
    return out.slice(0, UNIVERSE_TARGET_LIMIT);
  }catch(e){
    return DEFAULT_CANDIDATES.slice(0, UNIVERSE_TARGET_LIMIT);
  }
}

/* =========================
   State (전역)
========================= */
let state = loadState() || {
  symbol: "BTCUSDT",
  tf: "60",
  universe: DEFAULT_CANDIDATES.map(x => ({...x})),
  activePositions: [],
  history: { total: 0, win: 0 },
  closedTrades: [],
  lastUniverseAt: 0,
  btcDom: null,
  btcDomPrev: null,
  lastApiHealth: "warn",
  lastSignalAt: {},
  lastScanAt: 0,
  lastScanResults: [],
  lastPrices: {},

  /* ✅ NEW: 공통 작업 취소 플래그/토큰 */
  op: { cancel: false, token: 0 }
};

ensurePatternDB();

let tempPos = null; // 모달 임시 포지션(features에서 사용)

/* =========================
   ✅ State shape guard (마이그레이션/누락 보정)
========================= */
function ensureCoreStateShape(){
  let changed = false;

  if(!state || typeof state !== "object"){
    state = {
      symbol: "BTCUSDT",
      tf: "60",
      universe: DEFAULT_CANDIDATES.map(x => ({...x})),
      activePositions: [],
      history: { total: 0, win: 0 },
      closedTrades: [],
      lastUniverseAt: 0,
      btcDom: null,
      btcDomPrev: null,
      lastApiHealth: "warn",
      lastSignalAt: {},
      lastScanAt: 0,
      lastScanResults: [],
      lastPrices: {},
      op: { cancel: false, token: 0 }
    };
    changed = true;
  }

  if(!Array.isArray(state.universe) || state.universe.length < 10){
    state.universe = DEFAULT_CANDIDATES.map(x => ({...x}));
    changed = true;
  }

  if(!Array.isArray(state.activePositions)){ state.activePositions = []; changed = true; }
  if(!state.history || typeof state.history !== "object"){ state.history = { total: 0, win: 0 }; changed = true; }
  if(!Number.isFinite(state.history.total)) { state.history.total = 0; changed = true; }
  if(!Number.isFinite(state.history.win))   { state.history.win = 0; changed = true; }

  if(!Array.isArray(state.closedTrades)){ state.closedTrades = []; changed = true; }
  if(!state.lastSignalAt || typeof state.lastSignalAt !== "object"){ state.lastSignalAt = {}; changed = true; }
  if(!Array.isArray(state.lastScanResults)){ state.lastScanResults = []; changed = true; }
  if(!state.lastPrices || typeof state.lastPrices !== "object"){ state.lastPrices = {}; changed = true; }

  if(!state.op || typeof state.op !== "object"){
    state.op = { cancel: false, token: 0 };
    changed = true;
  }else{
    if(typeof state.op.cancel !== "boolean"){ state.op.cancel = false; changed = true; }
    if(!Number.isFinite(state.op.token)){ state.op.token = 0; changed = true; }
  }

  if(changed) saveState();
}

/* =========================
   ✅ 공통 초기화/취소 API (요구사항 1 핵심)
   - UI 갱신은 features에서 처리
========================= */
function requestCancelOperation(){
  // “다음 단계부터 즉시 멈춤”용
  ensureCoreStateShape();
  state.op.cancel = true;
  state.op.token = (state.op.token || 0) + 1;
  saveState();
  return state.op.token;
}
function clearCancelOperation(){
  ensureCoreStateShape();
  state.op.cancel = false;
  saveState();
}
function isOperationCancelled(token){
  // token 기반으로 “취소 이후 단계”를 구분 가능
  const t = Number(token || 0);
  const cur = Number(state?.op?.token || 0);
  return !!state?.op?.cancel || (t > 0 && cur >= t);
}

function resetStatsData(){
  // 누적 분석/성공률 초기화 (요구 1)
  ensureCoreStateShape();
  state.history = { total: 0, win: 0 };
  state.closedTrades = [];
  saveState();
}

function cancelAllTrackingData(){
  // 정밀추적(추적중) 전부 취소 (요구 1)
  ensureCoreStateShape();
  state.activePositions = [];
  tempPos = null;
  saveState();
}

function resetAllData(){
  // 누적 + 추적 + 스캔/작업 상태까지 초기화 (요구 1 강화)
  ensureCoreStateShape();
  requestCancelOperation();
  state.history = { total: 0, win: 0 };
  state.closedTrades = [];
  state.activePositions = [];
  state.lastSignalAt = {};
  state.lastScanAt = 0;
  state.lastScanResults = [];
  tempPos = null;
  saveState();
}

/* =========================
   Time helpers (카운트다운)
========================= */
function tfToMs(tfRaw){
  if(tfRaw === "60") return 60 * 60 * 1000;
  if(tfRaw === "240") return 4 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function formatRemain(ms){
  ms = Math.max(0, ms|0);

  const totalSec = Math.floor(ms / 1000);
  const ss = totalSec % 60;

  const totalMin = Math.floor(totalSec / 60);
  const mm = totalMin % 60;

  const totalH = Math.floor(totalMin / 60);
  const hh = totalH % 24;

  const dd = Math.floor(totalH / 24);

  if(dd > 0) return `${dd}일 ${hh}시간`;
  if(totalH > 0) return `${totalH}시간 ${mm}분 ${ss}초`;
  return `${totalMin}분 ${ss}초`;
}

// ✅ FIX (핵심): expiryAt 우선 사용 + 없으면 생성하여 불일치 방지
function getPosExpiryAt(pos){
  if(!pos) return Date.now();

  const start = pos.createdAt || Date.now();
  const tfRaw = pos.tfRaw || state.tf || "60";
  const expected = start + tfToMs(tfRaw);

  if(Number.isFinite(pos.expiryAt) && pos.expiryAt > 0){
    return pos.expiryAt;
  }

  pos.createdAt = start;
  pos.expiryAt = expected;
  try{ saveState(); }catch(e){}
  return expected;
}

/* =========================
   TOAST (alert 대체)
========================= */
function ensureToastUI(){
  if(document.getElementById("yopo-toast-wrap")) return;

  const wrap = document.createElement("div");
  wrap.id = "yopo-toast-wrap";
  wrap.style.position = "fixed";
  wrap.style.top = "16px";
  wrap.style.right = "16px";
  wrap.style.zIndex = "9999999";
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.gap = "10px";
  wrap.style.pointerEvents = "none";
  document.body.appendChild(wrap);
}

function toast(msg, kind="info"){
  ensureToastUI();
  const wrap = document.getElementById("yopo-toast-wrap");
  if(!wrap) return;

  const el = document.createElement("div");
  el.style.pointerEvents = "none";
  el.style.minWidth = "260px";
  el.style.maxWidth = "360px";
  el.style.padding = "12px 14px";
  el.style.borderRadius = "14px";
  el.style.border = "1px solid var(--border)";
  el.style.boxShadow = "0 14px 32px rgba(0,0,0,.14)";
  el.style.fontWeight = "950";
  el.style.fontSize = "12px";
  el.style.lineHeight = "1.35";
  el.style.background = "#fff";
  el.style.opacity = "0";
  el.style.transform = "translateY(-6px)";
  el.style.transition = "opacity .18s ease, transform .18s ease";

  let leftBar = "var(--primary)";
  let title = "알림";
  if(kind === "success"){ leftBar = "var(--success)"; title = "성공"; }
  if(kind === "danger"){ leftBar = "var(--danger)"; title = "실패"; }
  if(kind === "warn"){ leftBar = "#f59e0b"; title = "주의"; }

  el.style.borderLeft = `5px solid ${leftBar}`;
  el.innerHTML = `<div style="font-size:11px; color:var(--text-sub); margin-bottom:4px;">${title}</div><div>${msg}</div>`;

  wrap.appendChild(el);

  requestAnimationFrame(()=>{
    el.style.opacity = "1";
    el.style.transform = "translateY(0)";
  });

  setTimeout(()=>{
    el.style.opacity = "0";
    el.style.transform = "translateY(-6px)";
    setTimeout(()=>{ try{ el.remove(); }catch(e){} }, 220);
  }, 3800);
}

/* =========================
   Migration helper
========================= */
function ensureExpiryOnAllPositions(){
  if(!state.activePositions?.length) return;
  let changed = false;

  for(const p of state.activePositions){
    if(!p.createdAt){
      p.createdAt = Date.now();
      changed = true;
    }

    const expected = p.createdAt + tfToMs(p.tfRaw);

    if(!p.expiryAt || Math.abs(p.expiryAt - expected) > (5 * 60 * 1000)){
      p.expiryAt = expected;
      changed = true;
    }

    if(typeof p.mfePct !== "number"){
      p.mfePct = 0;
      changed = true;
    }

    if(p.type !== "HOLD"){
      if(typeof p.sl !== "number" || !Number.isFinite(p.sl)) { p.sl = p.sl ?? p.entry; changed = true; }
      if(typeof p.tp !== "number" || !Number.isFinite(p.tp)) { p.tp = p.tp ?? p.entry; changed = true; }
    }

    if(!p.sig && p.explain && p.symbol && p.tfRaw && p.type && p.type !== "HOLD"){
      p.sig = buildPatternSignature(p.symbol, p.tfRaw, p.type, p.explain);
      changed = true;
    }
  }

  if(changed) saveState();
}

/* =========================
   MTF helpers
========================= */
function getMTFSet3(){ return ["60", "240", "D"]; }

function getMTFSet2(baseTf){
  if(baseTf === "15") return ["15","30"];
  if(baseTf === "30") return ["30","60"];
  if(baseTf === "60") return ["60","240"];
  if(baseTf === "240") return ["240","D"];
  if(baseTf === "D") return ["D","W"];
  if(baseTf === "W") return ["W","D"];
  return ["60","240"];
}

function tfName(tfRaw){
  if(tfRaw === "15") return "15M";
  if(tfRaw === "30") return "30M";
  if(tfRaw === "60") return "1H";
  if(tfRaw === "240") return "4H";
  if(tfRaw === "D") return "1D";
  if(tfRaw === "W") return "1W";
  return String(tfRaw);
}

/* =========================
   Recent performance
========================= */
function getRecentWinRate(symbol, tfRaw, n=20){
  const list = state.closedTrades || [];
  let hit = 0, total = 0;
  for(const x of list){
    if(x.symbol !== symbol) continue;
    if(x.tfRaw !== tfRaw) continue;
    total++;
    if(x.win) hit++;
    if(total >= n) break;
  }
  if(total <= 0) return 0.5;
  return clamp(hit / total, 0.0, 1.0);
}


// ✅ BRAIN UPGRADE v3: 멀티 윈도우 유사도 앙상블(과적합 완화 + 안정성)
function calcSimilarityStatsEnsemble(closes, winLen, futureH, step, topK){
  const w1 = Math.max(25, Math.round(winLen * 0.8));
  const w2 = Math.max(30, winLen);
  const w3 = Math.max(35, Math.round(winLen * 1.2));

  const a = calcSimilarityStats(closes, w1, futureH, step, topK);
  const b = calcSimilarityStats(closes, w2, futureH, step, topK);
  const c = calcSimilarityStats(closes, w3, futureH, step, topK);

  const wa = Math.max(1, a.count);
  const wb = Math.max(1, b.count) * 1.15; // 기준 윈도우를 약간 우대
  const wc = Math.max(1, c.count);

  const sum = wa + wb + wc;

  const longProb = (a.longProb*wa + b.longProb*wb + c.longProb*wc) / sum;
  const shortProb = (a.shortProb*wa + b.shortProb*wb + c.shortProb*wc) / sum;

  const avgSim = (a.avgSim*wa + b.avgSim*wb + c.avgSim*wc) / sum;
  const count = Math.round((a.count + b.count + c.count) / 3);

  // 분산(윈도우 간 충돌)을 간단히 계산해서 품질 페널티에 사용
  const lp = [a.longProb, b.longProb, c.longProb];
  const mp = (lp[0]+lp[1]+lp[2])/3;
  const varP = ((lp[0]-mp)**2 + (lp[1]-mp)**2 + (lp[2]-mp)**2)/3;

  return { longProb, shortProb, avgSim, count, varP };
}

/* =========================
   Signal core (지표/유사도/합의)
========================= */
function computeSignalCore(symbol, tfRaw, candles){
  const closes = candles.map(x => x.c);
  const highs  = candles.map(x => x.h);
  const lows   = candles.map(x => x.l);
  const vols   = candles.map(x => x.v);

  const entry = closes[closes.length - 1];

  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const atrRaw = calcATR(highs, lows, closes, 14);
  const atrChg = calcATRChange(highs, lows, closes, 14, 14);
  const bbWidth = calcBollingerBandwidth(closes, 20, 2);
  const adxPack = calcADX(highs, lows, closes, 14);
  const adx = adxPack.adx;
  const plusDI = adxPack.plusDI;
  const minusDI = adxPack.minusDI;

  const obv = calcOBV(closes, vols);
  const vroc = calcVolumeROC(vols, 20);
  const vsp = detectVolumeSpike(vols, 30);
  const volSpike = vsp.spike;

  const volTrend = calcVolumeTrend(vols, 20);
  const ema20 = emaLast(closes, 20);
  const ema50 = emaLast(closes, 50);
  const trend = (ema20 >= ema50) ? 1 : -1;

  const trendStrength = (atrRaw > 0) ? (Math.abs(ema20 - ema50) / atrRaw) : 0;
  const atrPct = (entry > 0) ? ((atrRaw / entry) * 100) : 0;

  const sim = (typeof calcSimilarityStatsEnsemble === 'function')
    ? calcSimilarityStatsEnsemble(closes, SIM_WINDOW, FUTURE_H, SIM_STEP, SIM_TOPK)
    : calcSimilarityStats(closes, SIM_WINDOW, FUTURE_H, SIM_STEP, SIM_TOPK);

  const dom = (typeof state.btcDom === "number") ? state.btcDom : null;
  const domPrev = (typeof state.btcDomPrev === "number") ? state.btcDomPrev : null;
  const domUp = (dom !== null && domPrev !== null) ? (dom - domPrev) : 0;

  const isAlt = (symbol !== "BTCUSDT");
  let domDamp = 1.0;
  let domHoldBoost = 0.0;
  if(dom !== null){
    if(dom > 50) domDamp *= 0.88;
    if(domUp > 0.15) { domDamp *= 0.85; domHoldBoost += 1; }
    if(isAlt && dom > 53) { domDamp *= 0.82; domHoldBoost += 1; }
  }

  let longP = sim.longProb;
  let shortP = sim.shortProb;

  const rsiBias = clamp((50 - rsi) / 50, -1, 1);
  const macdBias = clamp(macd.hist * 6, -1, 1);
  const volBias = clamp(volTrend, -1, 1);
  const trendBias = clamp(trend * 0.8, -1, 1);

  // ✅ v4 추가: 추세강도/변동성구조/거래량 힌트 (가벼운 보정)
  const adxBias = clamp((adx - 18) / 25, -1, 1); // 18 이하 약함, 40 이상 강함
  const diBias = clamp((plusDI - minusDI) / 40, -1, 1); // +면 롱, -면 숏 힘
  const bbBias = clamp((bbWidth - 0.03) / 0.08, -1, 1); // 폭이 넓으면 추세/폭발 가능
  const atrChgBias = clamp(atrChg * 1.5, -1, 1); // 변동성 급증/급감
  const volSpikeBias = clamp(volSpike * 1.0, 0, 1); // 스파이크는 방향보다 확신/엣지에 영향

  longP  += (0.12 * rsiBias) + (0.10 * macdBias) + (0.06 * volBias) + (0.08 * trendBias)
         + (0.05 * adxBias) + (0.06 * diBias) + (0.03 * bbBias) + (0.02 * atrChgBias);
  shortP += (-0.12 * rsiBias) + (-0.10 * macdBias) + (-0.06 * volBias) + (-0.08 * trendBias)
         + (0.05 * adxBias) + (-0.06 * diBias) + (0.03 * bbBias) + (0.02 * atrChgBias);

  // 거래량 스파이크는 '확신/엣지' 쪽으로만 약하게 반영 (방향 강제 X)
  if(volSpikeBias > 0){
    const bump = 0.02 * volSpikeBias;
    longP = 0.5 + (longP - 0.5) * (1 + bump);
    shortP = 0.5 + (shortP - 0.5) * (1 + bump);
  }

  longP  = 0.5 + (longP - 0.5) * domDamp;
  shortP = 0.5 + (shortP - 0.5) * domDamp;

  const sum = Math.max(longP + shortP, 1e-9);
  longP /= sum; shortP /= sum;

  const type = (longP >= shortP) ? "LONG" : "SHORT";
  const winProb = Math.max(longP, shortP);
  const edge = Math.abs(longP - shortP);

  return {
    entry,
    tfRaw,
    type,
    winProb,
    longP,
    shortP,
    edge,
    simAvg: sim.avgSim,
    simCount: sim.count,
    simVar: (typeof sim.varP === 'number') ? sim.varP : null,
    rsi,
    macdHist: macd.hist,
    atrRaw,
    atrPct,
    volTrend,
    ema20,
    ema50,
    trend,
    trendStrength,
    adx,
    plusDI,
    minusDI,
    bbWidth,
    atrChg,
    obv,
    vroc,
    volSpike,
    btcDom: dom,
    btcDomUp: domUp,
    domHoldBoost
  };
}

function consensus3TF(cores){
  const w = MTF_WEIGHTS_3TF;

  let longP = 0, shortP = 0;
  let simAvgW = 0, simCountW = 0;
  let edgeW = 0, winProbW = 0;

  const votes = [];
  for(const tfRaw of Object.keys(w)){
    const c = cores[tfRaw];
    if(!c) continue;
    const wt = w[tfRaw] || 0;
    longP += (c.longP * wt);
    shortP += (c.shortP * wt);
    simAvgW += (c.simAvg * wt);
    simCountW += (c.simCount * wt);
    edgeW += (c.edge * wt);
    winProbW += (c.winProb * wt);
    votes.push(c.type);
  }

  const sum = Math.max(longP + shortP, 1e-9);
  longP /= sum; shortP /= sum;

  const type = (longP >= shortP) ? "LONG" : "SHORT";
  const winProb = Math.max(longP, shortP);
  let edge = Math.abs(longP - shortP);

  let agree = 0;
  for(const v of votes){
    if(v === type) agree++;
  }

  if(agree < MTF_MIN_AGREE){
    edge = Math.max(0, edge - MTF_DISAGREE_PENALTY);
  }

  return {
    longP, shortP, type, winProb, edge,
    simAvg: simAvgW,
    simCount: Math.round(simCountW),
    agree,
    votes
  };
}

function consensus2TF(baseCore, otherCore){
  const wb = MTF_WEIGHTS_2TF.base;
  const wo = MTF_WEIGHTS_2TF.other;

  let longP = baseCore.longP * wb + otherCore.longP * wo;
  let shortP = baseCore.shortP * wb + otherCore.shortP * wo;

  const sum = Math.max(longP + shortP, 1e-9);
  longP /= sum; shortP /= sum;

  const type = (longP >= shortP) ? "LONG" : "SHORT";
  const winProb = Math.max(longP, shortP);
  let edge = Math.abs(longP - shortP);

  const agree = (baseCore.type === otherCore.type) ? 2 : 1;
  if(agree < 2){
    edge = Math.max(0, edge - (MTF_DISAGREE_PENALTY * 0.7));
  }

  return {
    longP, shortP, type, winProb, edge,
    simAvg: (baseCore.simAvg * wb + otherCore.simAvg * wo),
    simCount: Math.round(baseCore.simCount * wb + otherCore.simCount * wo),
    agree,
    votes: [baseCore.type, otherCore.type]
  };
}

function getConfidenceTier(winProb, edge){
  const e = Math.max(0, edge || 0);
  const w = Math.max(0, Math.min(1, winProb || 0));

  if(e < CONF_EDGE_FLOOR) return "LOW";
  if(w >= CONF_TIER_HIGH.winProb && e >= CONF_TIER_HIGH.edge) return "HIGH";
  if(w >= CONF_TIER_MID.winProb && e >= CONF_TIER_MID.edge) return "MID";
  return "LOW";
}

function applyConfidenceTpSl(tpDist, winProb, edge){
  const tier = getConfidenceTier(winProb, edge);
  const tpScale = CONF_TP_SCALE[tier] ?? 1.0;
  const rr = CONF_RR_VALUE[tier] ?? RR;
  return { tier, rr, tpDist: tpDist * tpScale };
}

function buildSignalFromCandles_MTF(symbol, baseTfRaw, candlesByTf, mode="3TF"){
  const baseCandles = candlesByTf[baseTfRaw];
  const base = computeSignalCore(symbol, baseTfRaw, baseCandles);

  const entry = base.entry;

  const atrMin = entry * (ATR_MIN_PCT / 100);
  const atrUsed = Math.max(base.atrRaw, atrMin);

  const tfMult = TF_MULT[baseTfRaw] || 1.2;
  let tpDistBase = atrUsed * tfMult;

  let con = null;
  let mtfExplain = null;

  if(mode === "6TF"){
    const cores = {};
    for(const tfRaw of getMTFSet6()){
      const candles = candlesByTf[tfRaw];
      if(!candles || candles.length < (SIM_WINDOW + FUTURE_H + 40)) continue;
      cores[tfRaw] = computeSignalCore(symbol, tfRaw, candles);
    }
    const have = Object.keys(cores).length;
    if(have >= 3){
      const con6 = consensusMultiTF(cores, getMTFSet6());
      if(con6) con = con6;
      mtfExplain = cores;
    }
  }
  if(mode === "3TF"){
    const cores = {};
    for(const tfRaw of getMTFSet3()){
      const candles = candlesByTf[tfRaw];
      if(!candles || candles.length < (SIM_WINDOW + FUTURE_H + 80)) continue;
      cores[tfRaw] = computeSignalCore(symbol, tfRaw, candles);
    }
    const have = Object.keys(cores).length;
    if(have >= 2){
      if(have === 3){
        con = consensus3TF(cores);
      }else{
        const keys = Object.keys(cores);
        const c0 = cores[keys[0]];
        const c1 = cores[keys[1]];
        con = consensus2TF(c0, c1);
      }
      mtfExplain = cores;
    }else{
      con = {
        longP: base.longP, shortP: base.shortP,
        type: base.type, winProb: base.winProb, edge: base.edge,
        simAvg: base.simAvg, simCount: base.simCount,
        agree: 1, votes: [base.type]
      };
      mtfExplain = { [baseTfRaw]: base };
    }
  }else{
    const set = getMTFSet2(baseTfRaw);
    const otherTf = set[1];
    const otherCandles = candlesByTf[otherTf];

    if(otherCandles && otherCandles.length >= (SIM_WINDOW + FUTURE_H + 80)){
      const other = computeSignalCore(symbol, otherTf, otherCandles);
      con = consensus2TF(base, other);
      mtfExplain = { [baseTfRaw]: base, [otherTf]: other };
    }else{
      con = {
        longP: base.longP, shortP: base.shortP,
        type: base.type, winProb: base.winProb, edge: base.edge,
        simAvg: base.simAvg, simCount: base.simCount,
        agree: 1, votes: [base.type]
      };
      mtfExplain = { [baseTfRaw]: base };
    }
  }

  const type = con.type;

  const winProbRaw = con.winProb;
  let winProbAdj = winProbRaw;
  let edgeAdj = con.edge;

  const recent = getRecentWinRate(symbol, baseTfRaw, RECENT_CALIB_N);
  const recentDir = getRecentWinRateDir(symbol, baseTfRaw, type, Math.max(8, Math.floor(RECENT_CALIB_N/2)));
  // 기본 최근성공률 + 방향성 최근성공률을 함께 반영(과도한 흔들림 방지 위해 혼합)
  const recentMix = clamp(0.65*recent + 0.35*recentDir, 0.0, 1.0);
  winProbAdj = clamp((1 - RECENT_CALIB_ALPHA) * winProbAdj + RECENT_CALIB_ALPHA * recentMix, 0.5, 0.99);
  // ✅ NEW: 합의 강도 + 시장상황(regime) 보정
  const agreeN = Number(con?.agree || 1);
  // 합의가 높으면 약간 보너스(과대평가 방지로 아주 작게)
  if(mode === "6TF"){
    winProbAdj = clamp(winProbAdj + Math.max(0, Math.min(4, agreeN-2)) * 0.006, 0.50, 0.99);
    edgeAdj = Math.max(0, edgeAdj + Math.max(0, Math.min(4, agreeN-2)) * 0.04);
    // 합의가 너무 낮으면(충돌) 약간 패널티
    if(agreeN <= 2) winProbAdj = clamp(winProbAdj - 0.012, 0.50, 0.99);
  }
  const regime = classifyRegime(base.trendStrength, base.atrPct);
  const regAdj = applyRegimeAdjustment(winProbAdj, edgeAdj, regime, agreeN);
  winProbAdj = regAdj.winProb;
  edgeAdj = regAdj.edge;

  // ✅ BRAIN UPGRADE v3: 유사도 품질(표본/충돌) 페널티
  const baseSimCount = Number(base.simCount || 0);
  const baseSimAvg = Number(con.simAvg || 0);
  const simVar = (typeof base.simVar === "number") ? base.simVar : null;

  // 표본이 너무 적으면 과신 방지
  if(baseSimCount <= 1){
    winProbAdj = clamp(winProbAdj - 0.025, 0.50, 0.99);
    edgeAdj = Math.max(0, edgeAdj - 0.10);
  }else if(baseSimCount <= 2){
    winProbAdj = clamp(winProbAdj - 0.012, 0.50, 0.99);
    edgeAdj = Math.max(0, edgeAdj - 0.06);
  }

  // 윈도우 간 충돌(분산 높음) -> 확률/엣지 소폭 감점
  if(simVar !== null && Number.isFinite(simVar) && simVar > 0.004){
    const p = clamp((simVar - 0.004) / 0.010, 0, 1); // 0~1
    winProbAdj = clamp(winProbAdj - 0.018*p, 0.50, 0.99);
    edgeAdj = Math.max(0, edgeAdj - 0.08*p);
  }

  // avgSim이 낮은데 확률이 높은 경우 억제
  if(baseSimAvg < 58 && winProbAdj > 0.62){
    winProbAdj = clamp(winProbAdj - 0.012, 0.50, 0.99);
  }

  const holdReasons = [];
  const mtfVotes = (con.votes || []).join("/");

  const explainBase = {
    winProb: winProbAdj,
    winProbRaw: winProbRaw,
    recentWinRate: recent,
    recentWinRateDir: recentDir,
    longP: con.longP,
    shortP: con.shortP,
    edge: edgeAdj,
    simAvg: con.simAvg,
    simCount: con.simCount,
    simVar: (typeof base.simVar === 'number') ? base.simVar : null,

    // ✅ NEW: 합의/시장상황
    agreeN: Number(con?.agree || 1),
    regime: (typeof regime === "string") ? regime : null,

    rsi: base.rsi,
    macdHist: base.macdHist,
    atr: Math.max(atrUsed, 1e-9),
    atrPct: base.atrPct,
    volTrend: base.volTrend,
    ema20: base.ema20,
    ema50: base.ema50,
    trend: base.trend,
    trendStrength: base.trendStrength,
    adx: base.adx,
    plusDI: base.plusDI,
    minusDI: base.minusDI,
    bbWidth: base.bbWidth,
    atrChg: base.atrChg,
    volSpike: base.volSpike,
    vroc: base.vroc,
    btcDom: base.btcDom,
    btcDomUp: base.btcDomUp,

    conf: null,
    mtf: {
      mode,
      agree: con.agree,
      votes: con.votes,
      weights: (mode === "6TF") ? (con.weights || Object.fromEntries(getMTFSet6().map(tf=>[tf,1.0]))) : (mode === "3TF") ? MTF_WEIGHTS_3TF : MTF_WEIGHTS_2TF,
      relWeights: (mode === "6TF") ? Object.fromEntries(getMTFSet6().map(tf=>[tf, (typeof getTFReliabilityWeight==='function')?getTFReliabilityWeight(tf):1.0])) : null,
      detail: Object.fromEntries(Object.entries(mtfExplain || {}).map(([k,v]) => ([
        k,
        {
          tf: tfName(k),
          type: v.type,
          winProb: v.winProb,
          edge: v.edge,
          simAvg: v.simAvg,
          simCount: v.simCount,
          trendStrength: v.trendStrength,
          atrPct: v.atrPct
        }
      ])))
    },

    holdReasons,
    pattern: null
  };

  // ✅ v4 META: 현재 상황(레짐/변동성/추세강도/거래량/도미넌스)을 키로 묶어 학습
  const metaKey = buildMetaKey(symbol, baseTfRaw, type, regime, explainBase);
  explainBase.metaKey = metaKey;

  const sigForPenalty = buildPatternSignature(symbol, baseTfRaw, type, explainBase);
  const avoidMeta = getAvoidMeta(sigForPenalty);
  const pp = computePatternPenalty(avoidMeta);

  if(avoidMeta && pp.penalty > 0){
    winProbAdj = clamp(winProbAdj - pp.penalty, 0.50, 0.99);
    edgeAdj = Math.max(0, edgeAdj - (pp.penalty * PATTERN_PENALTY_EDGE_W));
  }
  // ✅ v4 META: 비슷한 상황의 과거 성적(메타 브레인)을 winProb에 반영
  try{
    const mAdj = applyMetaAdjustment(winProbAdj, explainBase.metaKey);
    winProbAdj = mAdj.winProb;
    explainBase.meta = mAdj.meta;
  }catch(e){
    explainBase.meta = null;
  }



  explainBase.pattern = avoidMeta ? {
    sig: sigForPenalty,
    n: Number(avoidMeta.n || 0),
    wr: Number(avoidMeta.wr || 0),
    penalty: pp.penalty,
    hardHold: pp.hardHold
  } : {
    sig: sigForPenalty,
    n: 0,
    wr: null,
    penalty: 0,
    hardHold: false
  };

  explainBase.winProb = winProbAdj;
  explainBase.edge = edgeAdj;

  const adj = applyConfidenceTpSl(tpDistBase, winProbAdj, edgeAdj);
  const tpDist = adj.tpDist;
  const rrUsed = adj.rr;
  explainBase.conf = { tier: adj.tier, rrUsed, tpScale: (CONF_TP_SCALE[adj.tier] ?? 1.0) };

  const slDist = tpDist / Math.max(rrUsed, 1.01);

  let tp = (type === "LONG") ? (entry + tpDist) : (entry - tpDist);
  let sl = (type === "LONG") ? (entry - slDist) : (entry + slDist);

  let tpPct = Math.abs((tp - entry) / entry) * 100;
  let slPct = Math.abs((sl - entry) / entry) * 100;

  if(tpPct > TP_MAX_PCT){
    tpPct = TP_MAX_PCT;
    const newTpDist = entry * (tpPct/100);
    tp = (type === "LONG") ? (entry + newTpDist) : (entry - newTpDist);
    sl = (type === "LONG")
      ? (entry - (newTpDist/Math.max(rrUsed, 1.01)))
      : (entry + (newTpDist/Math.max(rrUsed, 1.01)));
    slPct = Math.abs((sl - entry) / entry) * 100;
  }
  // ✅ v4: TP/SL '먼저 도달' 경험 확률 (목표=B)
  // - 과거 캔들에서 'TP 먼저'가 얼마나 자주 나왔는지 추정하여 winProb에 반영
  try{
    const baseForProb = baseCandles || candlesByTf[baseTfRaw];
    const est = estimateTpSlFirstProb(baseForProb, type, tpPct, slPct, FUTURE_H);
    if(est && typeof est.pTpFirst === "number" && Number.isFinite(est.pTpFirst)){
      const alphaTp = 0.32; // 과대반영 방지(0~1)
      winProbAdj = clamp((1-alphaTp)*winProbAdj + alphaTp*est.pTpFirst, 0.50, 0.99);
      // 엣지도 아주 약하게 보강(승률이 0.5에서 멀수록)
      edgeAdj = Math.max(0, edgeAdj + (est.pTpFirst - 0.5) * 0.10);
      explainBase.tpFirst = { pTpFirst: est.pTpFirst, n: est.n, alpha: alphaTp };
    }else{
      explainBase.tpFirst = { pTpFirst: null, n: (est && est.n) ? est.n : 0, alpha: 0 };
    }
  }catch(e){
    explainBase.tpFirst = { pTpFirst: null, n: 0, alpha: 0 };
  }



  if(con.simCount < HOLD_MIN_TOPK) holdReasons.push(`유사패턴 표본 부족(${con.simCount}개)`);
  if(con.simAvg < HOLD_MIN_SIM_AVG) holdReasons.push(`유사도 평균 낮음(${con.simAvg.toFixed(1)}%)`);
  if(edgeAdj < HOLD_MIN_EDGE) holdReasons.push(`롱/숏 차이 작음(엣지 ${(edgeAdj*100).toFixed(1)}%)`);
  if(tpPct < HOLD_MIN_TP_PCT) holdReasons.push(`목표수익 너무 작음(+${tpPct.toFixed(2)}%)`);

  if(con.votes && con.votes.length >= 2){
    const agreeNeed = (con.votes.length >= 6) ? Math.max(2, Math.ceil(con.votes.length * 0.60)) : (con.votes.length === 3) ? MTF_MIN_AGREE : 2;
    if(con.agree < agreeNeed){
      holdReasons.push(`타임프레임 합의 부족(${mtfVotes})`);
    }
  }

  const minStrength = REGIME_MIN_STRENGTH_BY_TF[baseTfRaw] ?? 0.5;
  const ts = base.trendStrength ?? 0;
  if(ts < minStrength){
    holdReasons.push(`추세 약함(강도 ${ts.toFixed(2)} < ${minStrength.toFixed(2)})`);
  }

  const maxAtrPct = VOL_MAX_ATR_PCT_BY_TF[baseTfRaw] ?? 3.0;
  const ap = base.atrPct ?? 0;
  if(ap > maxAtrPct){
    holdReasons.push(`급변동 위험(ATR ${ap.toFixed(2)}% > ${maxAtrPct.toFixed(2)}%)`);
  }

  if(base.domHoldBoost >= 2 && symbol !== "BTCUSDT") holdReasons.push(`BTC 도미넌스 환경이 알트에 불리(보수적)`);
  if(base.volTrend < -0.25) holdReasons.push(`거래량 흐름 약함(신뢰↓)`);

  if(avoidMeta && pp.penalty > 0){
    holdReasons.push(`(패턴 감점 적용: -${(pp.penalty*100).toFixed(1)}%p, n=${avoidMeta.n}, wr ${(avoidMeta.wr*100).toFixed(0)}%)`);
  }

  const isHoldByBaseRules = holdReasons.some(r => !String(r).startsWith("(패턴 감점 적용"));
  const hardHold = !!(avoidMeta && pp.hardHold);
  if(hardHold){
    holdReasons.push(`실패패턴 극악(강제 HOLD): n=${avoidMeta.n}, wr ${(avoidMeta.wr*100).toFixed(0)}%`);
  }

  const finalHold = isHoldByBaseRules || hardHold;

  return {
    id: Date.now(),
    symbol,
    tf: tfName(baseTfRaw),
    tfRaw: baseTfRaw,
    type: finalHold ? "HOLD" : type,
    entry,
    tp: finalHold ? null : tp,
    sl: finalHold ? null : sl,
    tpPct: finalHold ? null : tpPct,
    slPct: finalHold ? null : slPct,
    createdAt: Date.now(),
    explain: explainBase,
    sig: finalHold ? null : sigForPenalty
  };
}

function buildSignalFromCandles(symbol, tf, candles){
  const byTf = { [tf]: candles };
  return buildSignalFromCandles_MTF(symbol, tf, byTf, "2TF");
}

/* =========================
   Similarity (최근가중)
========================= */
function calcSimilarityStats(closes, winLen, futureH, step, topK){
  const n = closes.length;
  const curStart = n - winLen;
  const curSeg = closes.slice(curStart, n);
  const curRet = returns(curSeg);

  const sims = [];
  const lastStart = n - winLen - futureH - 2;

  for(let s=0; s<=lastStart; s+=step){
    const seg = closes.slice(s, s + winLen);
    const ret = returns(seg);
    const sim = zncc(curRet, ret);
    if(!Number.isFinite(sim)) continue;

    const entry = closes[s + winLen - 1];
    const future = closes[s + winLen - 1 + futureH];
    const r = (future - entry) / Math.max(entry, 1e-12);

    const ageSteps = (lastStart - s) / Math.max(step, 1);
    const w = Math.exp(-Math.log(2) * (ageSteps / Math.max(SIM_RECENCY_HALFLIFE_STEPS, 1)));

    sims.push({ sim, r, w });
  }

  sims.sort((a,b)=> b.sim - a.sim);
  const top = sims.slice(0, Math.min(topK, sims.length));

  const count = top.length;
  if(count === 0){
    return { longProb: 0.5, shortProb: 0.5, avgSim: 0, count: 0 };
  }

  let wSum = 0, wUp = 0, wDown = 0;
  for(const x of top){
    const w = Number.isFinite(x.w) ? x.w : 1;
    wSum += w;
    if(x.r >= 0) wUp += w;
    else wDown += w;
  }

  const longProb = (wUp + 1) / (wSum + 2);
  const shortProb = (wDown + 1) / (wSum + 2);

  let avgZ = 0;
  for(const x of top){
    const w = Number.isFinite(x.w) ? x.w : 1;
    avgZ += (x.sim * w);
  }
  avgZ = avgZ / Math.max(wSum, 1e-9);
  const avgSim = clamp((avgZ + 1) * 50, 0, 100);

  return { longProb, shortProb, avgSim, count };
}


// ✅ BRAIN UPGRADE v3: 멀티 윈도우 유사도 앙상블(과적합 완화 + 안정성)
// (dedup) calcSimilarityStatsEnsemble defined earlier — removed duplicate

function returns(seg){
  const out = [];
  for(let i=1;i<seg.length;i++){
    out.push((seg[i] - seg[i-1]) / Math.max(seg[i-1], 1e-12));
  }
  return out;
}

function zncc(a,b){
  const m = Math.min(a.length, b.length);
  if(m < 5) return 0;

  const a0 = a.slice(0,m);
  const b0 = b.slice(0,m);

  const ma = mean(a0), mb = mean(b0);
  let sa = 0, sb = 0;
  for(let i=0;i<m;i++){
    sa += (a0[i]-ma)*(a0[i]-ma);
    sb += (b0[i]-mb)*(b0[i]-mb);
  }
  sa = Math.sqrt(sa / m);
  sb = Math.sqrt(sb / m);
  if(sa === 0 || sb === 0) return 0;

  let dot = 0;
  for(let i=0;i<m;i++){
    dot += ((a0[i]-ma)/sa) * ((b0[i]-mb)/sb);
  }
  return dot / m;
}

function mean(arr){
  return arr.reduce((a,b)=>a+b,0) / Math.max(arr.length,1);
}

/* =========================
   Indicators
========================= */
function calcRSI(closes, period=14){
  if(closes.length < period+1) return 50;
  let gains = 0, losses = 0;
  for(let i = closes.length - period - 1; i < closes.length - 1; i++){
    const diff = closes[i+1] - closes[i];
    if(diff >= 0) gains += diff;
    else losses -= diff;
  }
  if(losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function ema(values, period){
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for(let i=1;i<values.length;i++){
    prev = values[i]*k + prev*(1-k);
    out.push(prev);
  }
  return out;
}

function emaLast(values, period){
  if(values.length < period) return values[values.length-1] || 0;
  const e = ema(values.slice(-Math.max(period*3, period+5)), period);
  return e[e.length-1];
}

function calcMACD(closes){
  if(closes.length < 60) return { macd:0, signal:0, hist:0 };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const macdLine = e12.map((v,i)=> v - e26[i]);
  const signalLine = ema(macdLine, 9);
  const macd = macdLine[macdLine.length-1];
  const signal = signalLine[signalLine.length-1];
  const hist = macd - signal;
  return { macd, signal, hist };
}

function calcATR(highs, lows, closes, period=14){
  if(closes.length < period+1) return 0;
  const trs = [];
  for(let i=1;i<closes.length;i++){
    const h = highs[i], l = lows[i], pc = closes[i-1];
    const tr = Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const sum = slice.reduce((a,b)=>a+b,0);
  return sum / slice.length;
}


/* ==========================================================
   ✅ BRAIN UPGRADE v4: 추가 피처(거래량/변동성구조/추세강도)
   - 브라우저에서 얻는 캔들만으로 계산 가능
   ========================================================== */
function calcOBV(closes, vols){
  const n = Math.min(closes.length, vols.length);
  if(n < 2) return 0;
  let obv = 0;
  for(let i=1;i<n;i++){
    const v = Number(vols[i] || 0);
    if(closes[i] > closes[i-1]) obv += v;
    else if(closes[i] < closes[i-1]) obv -= v;
  }
  return obv;
}

function calcVolumeROC(vols, period=20){
  if(vols.length < period+1) return 0;
  const a = Number(vols[vols.length-1] || 0);
  const b = Number(vols[vols.length-1-period] || 0);
  if(b <= 0) return 0;
  return (a - b) / b; // ratio
}

function detectVolumeSpike(vols, lookback=30){
  const n = vols.length;
  if(n < lookback+1) return { spike: 0, z: 0 };
  const slice = vols.slice(n-lookback);
  const mean = slice.reduce((s,x)=>s+Number(x||0),0)/lookback;
  const varr = slice.reduce((s,x)=>{const d=Number(x||0)-mean; return s+d*d;},0)/lookback;
  const sd = Math.sqrt(Math.max(varr, 1e-9));
  const last = Number(vols[n-1]||0);
  const z = (sd>0) ? (last-mean)/sd : 0;
  // spike: 0~1 (z>2부터 증가)
  const spike = clamp((z-2)/3, 0, 1);
  return { spike, z };
}

function calcBollingerBandwidth(closes, period=20, mult=2){
  if(closes.length < period) return 0;
  const slice = closes.slice(closes.length-period);
  const mean = slice.reduce((s,x)=>s+x,0)/period;
  const varr = slice.reduce((s,x)=>{const d=x-mean; return s+d*d;},0)/period;
  const sd = Math.sqrt(Math.max(varr, 0));
  if(mean === 0) return 0;
  const upper = mean + mult*sd;
  const lower = mean - mult*sd;
  return (upper - lower) / mean; // ratio
}

function calcATRChange(highs, lows, closes, period=14, lookback=14){
  if(closes.length < period + lookback + 2) return 0;
  const atrNow = calcATR(highs, lows, closes, period);
  const subCloses = closes.slice(0, closes.length-lookback);
  const subHighs  = highs.slice(0, highs.length-lookback);
  const subLows   = lows.slice(0, lows.length-lookback);
  const atrPrev = calcATR(subHighs, subLows, subCloses, period);
  if(atrPrev <= 0) return 0;
  return (atrNow - atrPrev) / atrPrev; // ratio
}

function calcADX(highs, lows, closes, period=14){
  // Lightweight ADX (Wilder)
  const n = closes.length;
  if(n < period + 2) return { adx: 0, plusDI: 0, minusDI: 0 };
  let tr14=0, plusDM14=0, minusDM14=0;
  // init
  for(let i=1;i<=period;i++){
    const up = highs[i]-highs[i-1];
    const dn = lows[i-1]-lows[i];
    const plusDM = (up>dn && up>0) ? up : 0;
    const minusDM = (dn>up && dn>0) ? dn : 0;
    const tr = Math.max(
      highs[i]-lows[i],
      Math.abs(highs[i]-closes[i-1]),
      Math.abs(lows[i]-closes[i-1])
    );
    tr14 += tr; plusDM14 += plusDM; minusDM14 += minusDM;
  }
  let plusDI = (tr14>0) ? (100*(plusDM14/tr14)) : 0;
  let minusDI = (tr14>0) ? (100*(minusDM14/tr14)) : 0;
  let dx = (plusDI+minusDI>0) ? (100*Math.abs(plusDI-minusDI)/(plusDI+minusDI)) : 0;
  let adx = dx;

  // smooth
  for(let i=period+1;i<n;i++){
    const up = highs[i]-highs[i-1];
    const dn = lows[i-1]-lows[i];
    const plusDM = (up>dn && up>0) ? up : 0;
    const minusDM = (dn>up && dn>0) ? dn : 0;
    const tr = Math.max(
      highs[i]-lows[i],
      Math.abs(highs[i]-closes[i-1]),
      Math.abs(lows[i]-closes[i-1])
    );
    tr14 = tr14 - (tr14/period) + tr;
    plusDM14 = plusDM14 - (plusDM14/period) + plusDM;
    minusDM14 = minusDM14 - (minusDM14/period) + minusDM;

    plusDI = (tr14>0) ? (100*(plusDM14/tr14)) : 0;
    minusDI = (tr14>0) ? (100*(minusDM14/tr14)) : 0;
    dx = (plusDI+minusDI>0) ? (100*Math.abs(plusDI-minusDI)/(plusDI+minusDI)) : 0;
    adx = adx - (adx/period) + dx;
  }
  adx = adx / period; // normalize smoothing output
  return { adx, plusDI, minusDI };
}

/* ==========================================================
   ✅ BRAIN UPGRADE v4: TP/SL '먼저 도달' 확률(경험적 추정)
   - 목표(B): TP 먼저 닿으면 성공, SL 먼저 닿으면 실패
   ========================================================== */
function estimateTpSlFirstProb(candles, dir, tpPct, slPct, horizonBars){
  const n = candles.length;
  if(n < 50) return { pTpFirst: null, pSlFirst: null, n: 0 };
  const tpR = Math.max(0.0001, Number(tpPct||0)/100);
  const slR = Math.max(0.0001, Number(slPct||0)/100);
  const H = Math.max(5, Math.min(200, Number(horizonBars||48)));

  const maxSamples = 220;
  const step = 3;
  let tpFirst=0, slFirst=0, cnt=0;

  for(let i=Math.max(10, n - (maxSamples*step) - H - 2); i < n - H - 2; i+=step){
    const entry = candles[i].c;
    if(!Number.isFinite(entry) || entry<=0) continue;

    const tp = (dir==="LONG") ? entry*(1+tpR) : entry*(1-tpR);
    const sl = (dir==="LONG") ? entry*(1-slR) : entry*(1+slR);

    let hit = null; // "TP"|"SL"|null
    for(let j=i+1; j<=i+H; j++){
      const h = candles[j].h, l = candles[j].l;
      if(dir==="LONG"){
        if(h >= tp){ hit="TP"; break; }
        if(l <= sl){ hit="SL"; break; }
      }else{
        if(l <= tp){ hit="TP"; break; }
        if(h >= sl){ hit="SL"; break; }
      }
    }
    if(hit==="TP") tpFirst++;
    else if(hit==="SL") slFirst++;
    cnt++;
  }

  const denom = tpFirst + slFirst;
  if(denom <= 10) return { pTpFirst: null, pSlFirst: null, n: denom };
  const pTpFirst = tpFirst/denom;
  const pSlFirst = slFirst/denom;
  return { pTpFirst, pSlFirst, n: denom };
}


function calcVolumeTrend(vols, lookback=20){
  if(vols.length < lookback*2) return 0;
  const a = avg(vols.slice(-lookback));
  const b = avg(vols.slice(-(lookback*2), -lookback));
  if(b === 0) return 0;
  return (a - b) / b;
}

function avg(arr){
  if(!arr.length) return 0;
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

/* =========================
   Protections (공용)
========================= */
function hasActivePosition(symbol, tfRaw){
  return (state.activePositions || []).some(p => p.symbol === symbol && p.tfRaw === tfRaw);
}

function isInCooldown(key, tfRaw = state.tf){
  const last = state.lastSignalAt?.[key] || 0;
  const cd = COOLDOWN_MS[tfRaw] || (10*60*1000);
  return (Date.now() - last) < cd;
}

/* =========================
   Fetch helpers (공용)  ✅ 완전 복구본(중복/깨진 꼬리 제거 완료)
========================= */
function clamp(x, a, b){
  x = Number(x);
  if(!Number.isFinite(x)) x = 0;
  return Math.max(a, Math.min(b, x));
}


/* =========================
   Regime helpers (NEW)
   - 시장 상태를 단순 분류해서 (추세/횡보/과변동/저변동)
     승률/엣지 보정에 사용한다.
========================= */
function classifyRegime(trendStrength, atrPct){
  const ts = Number(trendStrength)||0;
  const ap = Number(atrPct)||0;

  // ✅ 매우 단순 4분류 (과도한 복잡화 금지)
  // - TREND: 추세가 확실
  // - RANGE: 추세 약 + ATR 보통
  // - VOLATILE: 변동성 과다(휩쏘 위험)
  // - CALM: 변동성 낮음(수익폭 작음/미세노이즈)
  if(ts >= 0.55 && ap >= 0.45) return "TREND";
  if(ap >= 1.25) return "VOLATILE";
  if(ap <= 0.25) return "CALM";
  return "RANGE";
}

function applyRegimeAdjustment(winProb, edge, regime, agree){
  let wp = Number(winProb); let ed = Number(edge);
  const ag = Number(agree)||1;

  if(regime === "TREND"){
    // 추세장이면 합의(agree)가 높을수록 약간 보너스
    wp = clamp(wp + Math.min(4, Math.max(0, ag-2)) * 0.006, 0.50, 0.99);
    ed = Math.max(0, ed + Math.min(4, Math.max(0, ag-2)) * 0.05);
  }else if(regime === "VOLATILE"){
    // 과변동은 휩쏘 위험 → 승률/엣지 약간 다운 (단, 합의가 높으면 완화)
    const k = clamp(1 - Math.min(3, ag-1)*0.18, 0.45, 1.0); // agree 높을수록 완화
    wp = clamp(wp - 0.02 * k, 0.50, 0.99);
    ed = Math.max(0, ed - 0.12 * k);
  }else if(regime === "CALM"){
    // 저변동은 수익폭 작고 노이즈 많음 → 엣지 중심으로 살짝 다운
    wp = clamp(wp - 0.01, 0.50, 0.99);
    ed = Math.max(0, ed - 0.08);
  }else{
    // RANGE(횡보): 합의 낮으면 약간 패널티
    if(ag <= 2) wp = clamp(wp - 0.015, 0.50, 0.99);
  }
  return { winProb: wp, edge: ed };
}

function sleep(ms){
  return new Promise(res => setTimeout(res, ms));
}

async function fetchWithTimeout(url, timeoutMs=7000){
  const ctrl = new AbortController();
  const t = setTimeout(()=> ctrl.abort(), Math.max(1000, timeoutMs|0));
  try{
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }finally{
    clearTimeout(t);
  }
}

/* =========================
   NET: queued fetchJSON (anti-rate-limit / anti-freeze)
   - GitHub Pages 환경에서 API 폭주로 429/timeout이 자주 발생하므로
     "동시요청"을 강제로 줄이고(기본 1개), 실패 시 간격을 자동으로 늘립니다.
   - 동일 URL은 in-flight dedupe로 중복 요청을 합칩니다.
   - 실패해도 앱 전체가 멈추지 않도록 fetchJSON 자체가 최대한 복구합니다.
========================= */
const __net = {
  q: Promise.resolve(),
  lastAt: 0,
  gapMs: 250,          // 기본 최소 간격
  maxGapMs: 2500,      // 실패 시 최대 간격
  failStreak: 0,
  inflight: new Map(), // url -> Promise
};
function __netSleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function __netEnqueue(run){
  // FIFO queue (동시요청 1개로 고정)
  const prev = __net.q;
  let release;
  __net.q = new Promise(r => (release = r));
  try{
    await prev;
    // 최소 간격 유지
    const now = Date.now();
    const wait = Math.max(0, (__net.lastAt + __net.gapMs) - now);
    if(wait) await __netSleep(wait);
    const out = await run();
    __net.lastAt = Date.now();
    return out;
  } finally {
    release();
  }
}

async function fetchJSON(url, opt={}){
  const timeoutMs = opt.timeoutMs ?? 9000;
  const retry = opt.retry ?? 1;

  // 동일 URL 동시 요청은 1개로 합치기
  if(__net.inflight.has(url)) return __net.inflight.get(url);

  const job = __netEnqueue(async ()=>{
    let lastErr = null;

    for(let i=0;i<=retry;i++){
      try{
        const controller = new AbortController();
        const to = setTimeout(()=>controller.abort(), timeoutMs);

        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        clearTimeout(to);

        if(!res.ok){
          const e = new Error("HTTP " + res.status);
          e.status = res.status;
          throw e;
        }

        const ct = res.headers.get("content-type") || "";
        const data = ct.includes("application/json") ? await res.json() : await res.text();

        // 성공: 실패 누적 리셋 + 간격 완화
        __net.failStreak = 0;
        __net.gapMs = Math.max(200, Math.floor(__net.gapMs * 0.9));
        return data;

      }catch(err){
        lastErr = err;

        // 실패 누적: 간격 증가(429/timeout 방어)
        __net.failStreak += 1;
        const bump = (err?.status === 429) ? 600 : 250;
        __net.gapMs = Math.min(__net.maxGapMs, __net.gapMs + bump);

        // 재시도 전 backoff
        if(i < retry){
          const backoff = Math.min(1500, 250 * (i+1) + (__net.failStreak * 80));
          await __netSleep(backoff);
          continue;
        }
      }
    }
    throw lastErr || new Error("fetchJSON failed");
  });

  __net.inflight.set(url, job);
  try{
    return await job;
  } finally {
    __net.inflight.delete(url);
  }
}

/* =========================
   Core bootstrap (가벼운 초기화)
========================= */
(function coreBoot(){
  try{
    ensureCoreStateShape();
  }catch(e){}

  try{
    ensureExpiryOnAllPositions();
  }catch(e){}

  try{
    if(!isAuthed()) showAuth();
    else hideAuth();

    const input = document.getElementById("auth-input");
    if(input){
      input.addEventListener("keydown", (ev)=>{
        if(ev.key === "Enter") tryAuth();
      }, { passive:true });
    }
  }catch(e){}
})();


function getMTFSet6(){ return ['15','30','60','240','D','W']; }

function consensusMultiTF(cores, order){
  // 6TF 합의용(가중평균 + 투표/합의수)
  const wMap = { '15':0.80, '30':0.90, '60':1.00, '240':1.10, 'D':1.20, 'W':1.25 };
  let wSum=0, lSum=0, sSum=0, edgeSum=0, simSum=0, countSum=0;
  const votes = [];
  const weights = {};
  for(const tf of order){
    const c = cores[tf];
    if(!c) continue;
    const w0 = wMap[tf] ?? 1.0;
    const wRel = (typeof getTFReliabilityWeight === 'function') ? getTFReliabilityWeight(tf) : 1.0;
    const w = w0 * wRel;
    weights[tf] = w;
    const lp = Number(c.longP ?? 0.5), sp = Number(c.shortP ?? 0.5);
    lSum += lp*w; sSum += sp*w; wSum += w;
    edgeSum += Number(c.edge ?? 0)*w;
    simSum += Number(c.simAvg ?? 0)*w;
    countSum += Number(c.simCount ?? 0)*w;
    votes.push(c.type);
  }
  if(wSum<=0 || votes.length===0) return null;

  let longP = lSum/wSum, shortP = sSum/wSum;
  const sum = Math.max(longP + shortP, 1e-9);
  longP /= sum; shortP /= sum;

  const type = (longP>=shortP) ? 'LONG' : 'SHORT';
  const winProb = Math.max(longP, shortP);
  let edge = Math.abs(longP - shortP);

  let agree = 0;
  for(const v of votes){ if(v === type) agree++; }

  // 6TF는 최소 60% 합의(6개면 4개) 정도를 요구
  const need = Math.max(2, Math.ceil(votes.length * 0.60));
  if(agree < need){
    edge = Math.max(0, edge - (MTF_DISAGREE_PENALTY * 0.9));
  }

  return {
    longP, shortP, type, winProb, edge,
    simAvg: simSum/wSum,
    simCount: Math.round(countSum/wSum),
    agree,
    votes,
    weights
  };
}

const MIN_CANDLES_FOR_SIGNAL = 50; // safety guard  // ✅ 유니버스는 항상 30종으로 정규화
  state.universe = normalizeUniverse(state.universe);

