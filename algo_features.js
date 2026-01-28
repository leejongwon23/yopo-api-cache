/*************************************************************
 * YOPO AI PRO — app.features.js (분할 v1)
 * 역할: 화면/동작 전부(부트, 차트, 렌더, 분석/스캔/백테스트, 추적/만료, 모달)
 * 의존:
 * - app.core.js: state, tempPos, 유틸/신호코어/토스트/저장/마이그레이션 등
 * - app.api.js : refreshUniverseAndGlobals, marketTick, fetchCandles 등
 *
 * ✅ 중요:
 * - index.html onclick과 호환되도록 마지막에 window.xxx 바인딩을 한다.
 * - setTF는 btn이 없어도 안전하게 동작하도록 보강했다. (호환용)
 *************************************************************/

/* ==========================================================
   ✅ OPERATION CANCEL ENGINE (NEW)
   - 분석/스캔/백테스트 "진행중 취소"를 위한 공통 엔진
   - index.html 에서 버튼으로 window.cancelOperation() 호출하면 됨
   ========================================================== */
const __op = {
  running: false,
  kind: null,          // "ANALYSIS" | "SCAN" | "BACKTEST" | ...
  token: 0,
  canceled: false
};

function beginOperation(kind){
  __op.token++;
  __op.running = true;
  __op.kind = kind || "OP";
  __op.canceled = false;
  return __op.token;
}

/* ✅ FIX: 취소 버튼 누를 때 UX + 안전(작업 없어도 안내) */
function cancelOperation(){
  // 작업이 없어도 UX상 안내는 해주는게 좋음
  if(!__op.running){
    try{ toast("진행중인 작업이 없습니다.", "warn"); }catch(e){}
    return;
  }
  __op.canceled = true;
  try{ toast("진행 취소 요청 완료(다음 단계부터 중단).", "warn"); }catch(e){}
}

function endOperation(token){
  // 토큰이 다르면(새 작업 시작됨) 종료시키지 않음
  if(token !== __op.token) return;
  __op.running = false;
  __op.kind = null;
  __op.canceled = false;
}

function checkCanceled(token){
  if(token !== __op.token) throw new Error("CANCELLED");
  if(__op.canceled) throw new Error("CANCELLED");
}

function sleepCancelable(ms, token){
  return new Promise((resolve, reject)=>{
    const t = setTimeout(()=>resolve(), ms);
    const tick = () => {
      try{
        checkCanceled(token);
        setTimeout(tick, 80);
      }catch(e){
        clearTimeout(t);
        reject(e);
      }
    };
    setTimeout(tick, 0);
  });
}

/* ==========================================================
   ✅ SAFETY: formatMoney 폴백 (부트 중 renderUniverseList가 터지면
   setInterval이 아예 안 걸려서 "정산/통계/추적 갱신 멈춤" 현상이 생김)
   ========================================================== */
function formatMoney(n){
  const v = Number(n);
  if(!Number.isFinite(v)) return "-";
  const abs = Math.abs(v);
  if(abs >= 1e12) return (v/1e12).toFixed(2) + "T";
  if(abs >= 1e9)  return (v/1e9).toFixed(2)  + "B";
  if(abs >= 1e6)  return (v/1e6).toFixed(2)  + "M";
  if(abs >= 1e3)  return (v/1e3).toFixed(2)  + "K";
  return v.toFixed(0);
}

/* ==========================================================
   ✅ RUNTIME SAFETY (핵심)
   ========================================================== */
function ensureRuntimeState(){
  if(typeof state !== "object" || !state) return;

  if(!Array.isArray(state.activePositions)) state.activePositions = [];
  if(!Array.isArray(state.closedTrades)) state.closedTrades = [];

  if(typeof state.history !== "object" || !state.history){
    state.history = { total: 0, win: 0 };
  }

  if(!Number.isFinite(state.history.total)) state.history.total = 0;
  if(!Number.isFinite(state.history.win)) state.history.win = 0;

  if(!Array.isArray(state.universe)) state.universe = [];
  if(typeof state.lastPrices !== "object" || !state.lastPrices) state.lastPrices = {};
}

/* ==========================================================
   ✅ NEW: 운영 버튼 기능 (누적 리셋 / 추적 전체취소 / 전체 초기화)
   ========================================================== */
function resetStatsUIAndData(){
  ensureRuntimeState();

  state.history = { total: 0, win: 0 };
  state.closedTrades = [];

  // 스캔 결과는 유지하고 싶으면 아래 2줄 지워도 됨
  // state.lastScanResults = [];
  // state.lastScanAt = 0;

  saveState();

  try{ renderClosedTrades(); }catch(e){}
  try{ updateStatsUI(); }catch(e){}

  toast("누적(분석/성공률)과 종료 기록을 리셋했습니다.", "success");
}

function cancelAllTracking(){
  ensureRuntimeState();

  const n = (state.activePositions || []).length;
  state.activePositions = [];

  saveState();

  try{ renderTrackingList(); }catch(e){}
  try{ updateStatsUI(); }catch(e){}
  try{ updateStrategyCountUI(); }catch(e){}
  try{ updateCountdownTexts(); }catch(e){}

  toast(`추적 포지션 ${n}개를 전체 취소했습니다.`, "warn");
}

function resetAll(){
  ensureRuntimeState();

  // 진행중 작업 취소
  try{ cancelOperation(); }catch(e){}

  // 모달 닫기 + 멀티 상태 초기화
  try{ closeModal(); }catch(e){}

  // 누적/추적/스캔/쿨다운까지 싹 초기화
  state.history = { total: 0, win: 0 };
  state.closedTrades = [];
  state.activePositions = [];

  state.lastSignalAt = {};
  state.lastScanResults = [];
  state.lastScanAt = 0;

  saveState();

  try{ renderTrackingList(); }catch(e){}
  try{ renderClosedTrades(); }catch(e){}
  try{ renderScanResults(); }catch(e){}
  try{ updateStatsUI(); }catch(e){}

  toast("전체 초기화 완료 (누적 + 추적 + 진행취소 + 추천 초기화)", "success");
}

/* ==========================================================
   ✅ BUGFIX HELPERS
   ========================================================== */
function genPosId(){
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function ensurePosId(pos){
  if(!pos) return pos;
  if(!pos.id || typeof pos.id !== "string" || !pos.id.trim()){
    pos.id = genPosId();
  }
  return pos;
}

function ensureIdsOnAllPositions(){
  if(!state) return;
  if(Array.isArray(state.activePositions)){
    for(const p of state.activePositions) ensurePosId(p);
  }
  if(Array.isArray(state.closedTrades)){
    for(const r of state.closedTrades){
      if(!r.id) r.id = Date.now() + Math.floor(Math.random() * 1000);
    }
  }
}

/* ==========================================================
   ✅ NEW (예측 줄이지 않기용)
   ========================================================== */
function isPatternBlockedHold(pos){
  if(!pos || pos.type !== "HOLD") return false;
  const reasons = pos?.explain?.holdReasons || [];
  const text = reasons.map(x=>String(x)).join(" | ");
  return (
    text.includes("실패패턴") ||
    text.includes("패턴 감점 적용") ||
    text.includes("강제 HOLD")
  );
}

function buildForcedTrackFromHold(pos){
  if(!pos || pos.type !== "HOLD") return null;

  const ex = pos.explain || {};
  const symbol = pos.symbol;
  const tfRaw = pos.tfRaw;

  const longP = Number(ex.longP ?? 0.5);
  const shortP = Number(ex.shortP ?? 0.5);
  const inferredType = (longP >= shortP) ? "LONG" : "SHORT";

  const entry = Number.isFinite(pos.entry) ? pos.entry : null;
  if(!Number.isFinite(entry) || entry <= 0) return null;

  const TF_MULT_SAFE = (typeof TF_MULT === "object" && TF_MULT) ? TF_MULT : { "60":1.0, "240":1.15, "D":1.3 };
  const RR_SAFE = (typeof RR === "number" && Number.isFinite(RR)) ? RR : 1.6;
  const TP_MAX_PCT_SAFE = (typeof TP_MAX_PCT === "number" && Number.isFinite(TP_MAX_PCT)) ? TP_MAX_PCT : 6.0;

  const atrUsed = Number(ex.atr ?? 0);
  const tfMult = TF_MULT_SAFE[tfRaw] || 1.2;

  const tpScale = Number(ex?.conf?.tpScale ?? 1.0);
  const rrUsed = Number(ex?.conf?.rrUsed ?? RR_SAFE);

  let tpDist = atrUsed * tfMult * tpScale;
  if(!Number.isFinite(tpDist) || tpDist <= 0){
    return null;
  }

  let tp = (inferredType === "LONG") ? (entry + tpDist) : (entry - tpDist);
  let tpPct = Math.abs((tp - entry) / entry) * 100;

  if(tpPct > TP_MAX_PCT_SAFE){
    tpPct = TP_MAX_PCT_SAFE;
    const newTpDist = entry * (tpPct / 100);
    tpDist = newTpDist;
    tp = (inferredType === "LONG") ? (entry + newTpDist) : (entry - newTpDist);
  }

  const slDist = tpDist / Math.max(rrUsed, 1.01);
  let sl = (inferredType === "LONG") ? (entry - slDist) : (entry + slDist);
  let slPct = Math.abs((sl - entry) / entry) * 100;

  let sig = null;
  try{
    if(typeof buildPatternSignature === "function"){
      sig = buildPatternSignature(symbol, tfRaw, inferredType, ex);
    }
  }catch(e){}

  ensurePosId(pos);

  return {
    ...pos,
    type: inferredType,
    tp,
    sl,
    tpPct,
    slPct,
    sig,
    _forceTrack: true,
    _forceReason: "PATTERN_BLOCK_OVERRIDE"
  };
}

function computeScanScore(item){
  const w = Number(item.winProb ?? 0);
  const e = Number(item.edge ?? 0);
  const penalty = item.isRisk ? 0.06 : 0.0;
  return (w * 1.0) + (e * 0.7) - penalty;
}

/* ==========================================================
   ✅ MULTI (단/중/장 통합 예측) 상태
   ========================================================== */
let tempMulti = null;          // { "60":pos, "240":pos, "D":pos }
let selectedMultiPos = null;   // 선택된 pos(또는 forcedPos)

/* ==========================================================
   PATCH HELPERS (전략별 카운트 UI)
   ========================================================== */
function ensureStrategyCountUI(){
  const header = document.querySelector(".tracking-header");
  if(!header) return;
  if(document.getElementById("tf-counts")) return;

  const box = document.createElement("div");
  box.id = "tf-counts";
  box.style.display = "flex";
  box.style.gap = "8px";
  box.style.alignItems = "center";
  box.style.fontWeight = "950";
  box.style.fontSize = "11px";
  box.style.color = "var(--text-sub)";
  header.appendChild(box);
}

function updateStrategyCountUI(){
  const el = document.getElementById("tf-counts");
  if(!el) return;

  let c60 = 0, c240 = 0, cD = 0;
  for(const p of (state.activePositions || [])){
    if(p.tfRaw === "60") c60++;
    else if(p.tfRaw === "240") c240++;
    else cD++;
  }

  el.innerHTML = `
    <span style="background:var(--secondary); border:1px solid var(--border); padding:4px 8px; border-radius:999px;">1H ${c60}</span>
    <span style="background:var(--secondary); border:1px solid var(--border); padding:4px 8px; border-radius:999px;">4H ${c240}</span>
    <span style="background:var(--secondary); border:1px solid var(--border); padding:4px 8px; border-radius:999px;">1D ${cD}</span>
  `;
}

/* ==========================================================
   COUNTDOWN 부분 업데이트 + 만료 정산
   ========================================================== */
function updateCountdownTexts(){
  ensureRuntimeState();

  const list = state.activePositions || [];
  if(!list.length) return;

  for(const pos of list){
    ensurePosId(pos);

    const el = document.getElementById(`remain-${pos.id}`);
    if(!el) continue;

    const expiryAt = pos.expiryAt || getPosExpiryAt(pos);
    const remainMs = expiryAt - Date.now();
    el.textContent = formatRemain(remainMs);
  }
}

/* ==========================================================
   TIME 만료 정산 (MFE 반영) + 비용 반영
   ========================================================== */
function settleExpiredPositions(){
  ensureRuntimeState();

  const list = state.activePositions || [];
  if(!list.length) return false;

  const now = Date.now();
  let changed = false;

  const DRIFT_MS = 500;

  const FEE_SAFE = (typeof FEE_PCT === "number" && Number.isFinite(FEE_PCT)) ? FEE_PCT : 0;
  const TIME_MFE_MIN_SAFE = (typeof TIME_MFE_MIN_PCT === "number" && Number.isFinite(TIME_MFE_MIN_PCT)) ? TIME_MFE_MIN_PCT : 0;
  const TIME_MFE_RATIO_SAFE = (typeof TIME_MFE_TP_RATIO === "number" && Number.isFinite(TIME_MFE_TP_RATIO)) ? TIME_MFE_TP_RATIO : 0;

  for(let i = list.length - 1; i >= 0; i--){
    const pos = list[i];
    ensurePosId(pos);

    const expiryAt = pos.expiryAt || getPosExpiryAt(pos);

    if(Number.isFinite(expiryAt)){
      if(now < (expiryAt - DRIFT_MS)) continue;
    }

    const lastPrice = Number.isFinite(pos.lastPrice) ? pos.lastPrice : pos.entry;

    let pnlGross = 0;
    if(pos.type === "LONG"){
      pnlGross = ((lastPrice - pos.entry) / pos.entry) * 100;
    }else{
      pnlGross = ((pos.entry - lastPrice) / pos.entry) * 100;
    }
    const pnl = pnlGross - FEE_SAFE;
    pos.pnl = pnl;

    const mfe = (typeof pos.mfePct === "number") ? pos.mfePct : 0;
    const tpPct = Number.isFinite(pos.tpPct) ? pos.tpPct : null;

    let win = false;
    let reason = "TIME";

    if(pnl > 0){
      win = true;
      reason = "TIME";
    }else{
      const needByTp = (tpPct !== null) ? (tpPct * TIME_MFE_RATIO_SAFE) : TIME_MFE_MIN_SAFE;
      const need = Math.max(TIME_MFE_MIN_SAFE, needByTp);
      if(mfe >= need){
        win = true;
        reason = "TIME_MFE";
      }else{
        win = false;
        reason = "TIME";
      }
    }

    try{ recordTradeToPatternDB(pos, win); }catch(e){}
    try{ metaRecordFromPosition(pos, win, reason); }catch(e){}

    state.history.total++;
    if(win) state.history.win++;

    const record = {
      id: Date.now(),
      symbol: pos.symbol,
      tf: pos.tf,
      tfRaw: pos.tfRaw,
      type: pos.type,
      entry: pos.entry,
      exit: lastPrice,
      pnlPct: pnl,
      mfePct: mfe,
      win,
      reason,
      closedAt: Date.now()
    };

    state.closedTrades.unshift(record);
    state.closedTrades = state.closedTrades.slice(0, 30);

    list.splice(i, 1);
    changed = true;

    const extra = (reason === "TIME_MFE")
      ? ` / MFE ${mfe.toFixed(2)}% (보정승)`
      : ` / MFE ${mfe.toFixed(2)}%`;

    toast(
      `[${pos.symbol} ${pos.tf}] 시간 종료: ${win ? "성공" : "실패"} (${reason}) / 수익률 ${pnl.toFixed(2)}%${extra} (비용 -${FEE_SAFE.toFixed(2)}%)`,
      win ? "success" : "danger"
    );
  }

  if(changed){
    saveState();
    renderTrackingList();
    renderClosedTrades();
    updateStatsUI();
    updateStrategyCountUI();
    updateCountdownTexts();
  }

  return changed;
}

/* ==========================================================
   Boot
   ========================================================== */
document.addEventListener("DOMContentLoaded", async () => {
  ensureRuntimeState();

  if(!state.lastSignalAt || typeof state.lastSignalAt !== "object"){
    state.lastSignalAt = {};
  }

  try{
    if(!isAuthed()) showAuth();
    else hideAuth();
    document.getElementById("auth-input")?.addEventListener("keydown", (e)=>{
      if(e.key === "Enter") tryAuth();
    });
  }catch(e){}

  try{ ensureToastUI(); }catch(e){}

  try{ ensureExpiryOnAllPositions(); }catch(e){}
  try{ ensureIdsOnAllPositions(); saveState(); }catch(e){}

  try{ initChart(); }catch(e){}
  try{ renderUniverseList(); }catch(e){ console.error("renderUniverseList boot error:", e); }
  try{ renderTrackingList(); }catch(e){}
  try{ renderClosedTrades(); }catch(e){}
  try{ updateStatsUI(); }catch(e){}
  try{ renderScanResults(); }catch(e){}

  try{
    ensureStrategyCountUI();
    updateStrategyCountUI();
  }catch(e){}

  try{ await refreshUniverseAndGlobals(); }catch(e){}
  try{ await marketTick(); }catch(e){}

  /* ✅ FIX: app.api.js 로드 실패/순서 꼬임으로 marketTick/refresh...가 없으면
     기존 setInterval(marketTick, ...)에서 ReferenceError로 부트가 중단되어
     "카운트다운/정산/통계" 루프가 안 걸릴 수 있음 → 반드시 가드 */
  if(typeof marketTick === "function"){
    setInterval(() => {
      try{ marketTick(); }catch(e){ console.error("marketTick interval error:", e); }
    }, 2000);
  }else{
    console.warn("marketTick() not found. (app.api.js 로드/순서 문제 가능) — 가격추적은 꺼지지만, 카운트다운/정산은 유지됩니다.");
  }

  if(typeof refreshUniverseAndGlobals === "function"){
    setInterval(() => {
      try{ refreshUniverseAndGlobals(); }catch(e){ console.error("refreshUniverseAndGlobals interval error:", e); }
    }, 60000);
  }else{
    console.warn("refreshUniverseAndGlobals() not found. (app.api.js 로드/순서 문제 가능)");
  }

  // ✅ 이 루프는 어떤 상황에서도 반드시 살아 있어야 함
  setInterval(() => {
    try{ ensureRuntimeState(); }catch(e){}
    try{ updateCountdownTexts(); }catch(e){}
    try{ settleExpiredPositions(); }catch(e){}
  }, 1000);
});

/* ==========================================================
   UI 기본 (TF/코인)
   ========================================================== */
function setTF(tf, btn){
  ensureRuntimeState();

  state.tf = tf;

  const btns = Array.from(document.querySelectorAll(".tf-btn"));
  btns.forEach(b => b.classList.remove("active"));

  if(btn && btn.classList){
    btn.classList.add("active");
  }else{
    const mapIdx = (tf === "60") ? 0 : (tf === "240") ? 1 : 2;
    if(btns[mapIdx]) btns[mapIdx].classList.add("active");
  }

  saveState();
  initChart();
}

function switchCoin(symbol){
  ensureRuntimeState();

  state.symbol = symbol;
  document.querySelectorAll(".coin-row").forEach(r => r.classList.remove("active"));
  const row = document.getElementById(`row-${symbol}`);
  if(row) row.classList.add("active");
  saveState();
  initChart();
}

/* ==========================================================
   Chart
   ========================================================== */
function initChart(){
  const wrap = document.getElementById("chart-wrap");
  if(!wrap) return;

  wrap.innerHTML = "";
  new TradingView.widget({
    autosize:true,
    symbol:"BYBIT:" + state.symbol,
    interval:state.tf,
    timezone:"Asia/Seoul",
    theme:"light",
    style:"1",
    locale:"ko",
    toolbar_bg:"#f1f3f6",
    enable_publishing:false,
    hide_top_toolbar:false,
    container_id:"chart-wrap"
  });
}

/* ==========================================================
   Universe list + price row
   ========================================================== */
function renderUniverseList(){
  ensureRuntimeState();

  const container = document.getElementById("market-list-container");
  if(!container) return;

  container.innerHTML = "";
  state.universe.forEach(coin => {
    const div = document.createElement("div");
    div.className = `coin-row ${coin.s === state.symbol ? "active" : ""}`;
    div.id = `row-${coin.s}`;
    div.onclick = () => switchCoin(coin.s);

    div.innerHTML = `
      <div class="coin-info">
        <h4>${coin.s.replace("USDT","")}</h4>
        <span>${coin.n || "-"}</span>
      </div>
      <div class="coin-price" id="price-${coin.s}">
        <div class="p" id="p-${coin.s}">---</div>
        <div class="chg" id="c-${coin.s}">---</div>
        <div class="small-metrics" id="meta-${coin.s}"></div>
      </div>
    `;
    container.appendChild(div);

    const meta = document.getElementById(`meta-${coin.s}`);
    if(meta){
      const mcTxt = coin.mc ? `시총 ${formatMoney(coin.mc)}` : "";
      const volTxt = coin.vol ? `거래량 ${formatMoney(coin.vol)}` : "";
      const turnTxt = coin.turn ? `유동성 ${formatMoney(coin.turn)}` : "";
      const chgTxt = (typeof coin.chg === "number") ? `24h ${coin.chg.toFixed(1)}%` : "";
      meta.innerText = [mcTxt, volTxt, turnTxt, chgTxt].filter(Boolean).join(" · ");
    }

    const cached = state.lastPrices?.[coin.s];
    if(cached?.price){
      updateCoinRow(coin.s, cached.price, cached.chg ?? 0, true);
    }
  });
}

function updateCoinRow(symbol, price, changePct, silent=false){
  const pEl = document.getElementById(`p-${symbol}`);
  const cEl = document.getElementById(`c-${symbol}`);
  if(!pEl || !cEl) return;

  const color = changePct >= 0 ? "var(--success)" : "var(--danger)";
  const sign = changePct >= 0 ? "+" : "";

  pEl.style.color = "var(--primary)";
  pEl.textContent = `$${price.toLocaleString(undefined,{maximumFractionDigits:6})}`;

  cEl.style.color = color;
  cEl.textContent = `${sign}${changePct.toFixed(2)}%`;

  if(!silent){
    // UI 갱신은 위만으로 충분
  }
}

/* ==========================================================
   ✅ MULTI MODAL helpers
   ========================================================== */
function _hideMultiArea(){
  const multiWrap = document.getElementById("multi-results");
  const chooseBtn = document.getElementById("multi-choose");
  const selectedEl = document.getElementById("multi-selected");
  const cards = document.getElementById("multi-cards");
  const confirmBtn = document.getElementById("modal-confirm");

  if(multiWrap) multiWrap.style.display = "none";
  if(cards) cards.innerHTML = "";
  if(selectedEl) selectedEl.textContent = "선택: 없음";
  if(chooseBtn){
    chooseBtn.disabled = true;
    chooseBtn.style.opacity = "0.65";
    chooseBtn.textContent = "선택한 전략으로 추적 등록";
  }
  if(confirmBtn) confirmBtn.style.display = "";
}

function _showMultiArea(){
  const multiWrap = document.getElementById("multi-results");
  const chooseBtn = document.getElementById("multi-choose");
  if(multiWrap) multiWrap.style.display = "block";
  if(chooseBtn){
    chooseBtn.disabled = true;
    chooseBtn.style.opacity = "0.65";
  }
  const confirmBtn = document.getElementById("modal-confirm");
  if(confirmBtn) confirmBtn.style.display = "none";
}

/* ==========================================================
   ✅ 통합 예측 (단/중/장 한번에) + 선택/등록
   ========================================================== */
async function executeAnalysisAll(){
  ensureRuntimeState();

  const opToken = beginOperation("ANALYSIS_ALL");

  const btn = document.getElementById("predict-all-btn");
  if(btn){
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 통합 예측 중...';
  }

  try{
    checkCanceled(opToken);

    const symbol = state.symbol;
    const tfSet = getMTFSet6(); // 6 strategies
    const candlesByTf = {};

    for(const tfRaw of tfSet){
      checkCanceled(opToken);
      const candles = await fetchCandles(symbol, tfRaw, EXTENDED_LIMIT);
      candlesByTf[tfRaw] = candles;
    }

    // 3개 다 한 번에 계산
    const out = {};
    for(const baseTfRaw of tfSet){
      const baseCandles = candlesByTf[baseTfRaw] || [];
      if(baseCandles.length < (SIM_WINDOW + FUTURE_H + 80)){
        out[baseTfRaw] = null;
        continue;
      }
      let pos = null;
      try{
        pos = buildSignalFromCandles_MTF(symbol, baseTfRaw, candlesByTf, "6TF");
      }catch(err){
        console.warn("[ANALYSIS_ALL] buildSignal fail:", symbol, baseTfRaw, err);
        pos = null;
      }
      out[baseTfRaw] = pos;

      // 쿨다운은 "통합 예측 실행 시점" 기준으로 동일하게 걸어둠(단일과 일관성)
      const key = `${symbol}|${baseTfRaw}`;
      state.lastSignalAt[key] = Date.now();
    }

    saveState();
    showResultModalAll(symbol, out);
  }catch(e){
    if(String(e?.message || "").includes("CANCELLED")){
      toast("진행 중 작업이 취소되었습니다.", "warn");
      return;
    }
    console.error(e);
    toast("통합 예측 중 오류가 발생했습니다. (API 지연/제한 가능)", "danger");
  }finally{
    endOperation(opToken);
    if(btn){
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> 통합 예측(단·중·장) 실행';
    }
  }
}

/* ✅ 추천 클릭 → 통합 예측 모달 */
async function quickAnalyzeAllAndShow(symbol){
  ensureRuntimeState();

  const opToken = beginOperation("ANALYSIS_ALL");

  try{
    switchCoin(symbol);
    saveState();
    initChart();

    checkCanceled(opToken);

    const tfSet = getMTFSet6();
    const candlesByTf = {};
    for(const tfRaw of tfSet){
      checkCanceled(opToken);
      const candles = await fetchCandles(symbol, tfRaw, EXTENDED_LIMIT);
      candlesByTf[tfRaw] = candles;
    }

    const out = {};
    for(const baseTfRaw of tfSet){
      const baseCandles = candlesByTf[baseTfRaw] || [];
      if(baseCandles.length < (SIM_WINDOW + FUTURE_H + 80)){
        out[baseTfRaw] = null;
        continue;
      }
      try{
        try{
        out[baseTfRaw] = buildSignalFromCandles_MTF(symbol, baseTfRaw, candlesByTf, "6TF");
      }catch(err){
        console.warn("[PRED] buildSignal fail:", symbol, baseTfRaw, err);
        out[baseTfRaw] = null;
      }
      }catch(err){
        console.warn("[ANALYSIS_ALL] buildSignal fail:", symbol, baseTfRaw, err);
        out[baseTfRaw] = null;
      }
    }

    showResultModalAll(symbol, out);
  }catch(e){
    if(String(e?.message || "").includes("CANCELLED")){
      toast("진행 중 작업이 취소되었습니다.", "warn");
      return;
    }
    console.error(e);
    toast("통합 추천 분석 중 오류가 발생했습니다.", "danger");
  }finally{
    endOperation(opToken);
  }
}

/* ==========================================================
   Modal (단일)
   ========================================================== */
function showResultModal(pos){
  ensureRuntimeState();

  // 단일 모드 진입 시 멀티 영역 숨김(잔상 방지)
  _hideMultiArea();
  tempMulti = null;
  selectedMultiPos = null;

  let forcePos = null;
  const blockedByPattern = isPatternBlockedHold(pos);
  if(blockedByPattern){
    forcePos = buildForcedTrackFromHold(pos);
  }

  tempPos = pos;

  const modal = document.getElementById("result-modal");
  const icon = document.getElementById("modal-icon");
  const title = document.getElementById("modal-title");
  const subtitle = document.getElementById("modal-subtitle");
  const grid = document.getElementById("modal-grid");
  const content = document.getElementById("modal-content");
  const confirmBtn = document.getElementById("modal-confirm");

  if(!modal || !icon || !title || !subtitle || !grid || !content || !confirmBtn) return;

  const isLong = pos.type === "LONG";
  const isHold = pos.type === "HOLD";

  icon.textContent = isHold ? "⏸️" : (isLong ? "📈" : "📉");
  title.textContent = isHold ? "HOLD (보류)" : `${pos.type} SIGNAL`;
  title.style.color = isHold ? "var(--text-sub)" : (isLong ? "var(--success)" : "var(--danger)");
  subtitle.textContent = `${pos.symbol} | ${pos.tf}`;

  const ex = pos.explain;

  const mtf = ex.mtf;
  const mtfLine = mtf
    ? `MTF 합의: ${mtf.agree}/${(mtf.votes||[]).length} (${(mtf.votes||[]).join("/")})`
    : `MTF 합의: -`;

  const confLine = ex.conf
    ? `확신도: ${ex.conf.tier} (RR ${ex.conf.rrUsed.toFixed(2)}, TP×${(ex.conf.tpScale||1).toFixed(2)})`
    : `확신도: -`;

  const calibLine = `최근승률 ${(ex.recentWinRate*100).toFixed(0)}% → winProb ${(ex.winProb*100).toFixed(1)}% (α ${RECENT_CALIB_ALPHA})`;
  const regimeLine = `추세강도 ${Number(ex.trendStrength||0).toFixed(2)} / ATR ${Number(ex.atrPct||0).toFixed(2)}%`;

  if(isHold){
    const reasons = (ex.holdReasons || []).map(r => `- ${r}`).join("<br/>");

    if(blockedByPattern && forcePos){
      const inferredType = forcePos.type;
      const tpLine = `$${forcePos.tp.toLocaleString(undefined,{maximumFractionDigits:6})} (+${forcePos.tpPct.toFixed(2)}%)`;
      const slLine = `$${forcePos.sl.toLocaleString(undefined,{maximumFractionDigits:6})} (-${forcePos.slPct.toFixed(2)}%)`;

      icon.textContent = "⚠️";
      title.textContent = "RISK (패턴경고 감지)";
      title.style.color = "var(--danger)";

      grid.innerHTML = `
        <div class="mini-box"><small>판정</small><div>리스크 경고 (그래도 가능)</div></div>
        <div class="mini-box"><small>예상 방향</small><div>${inferredType}</div></div>
        <div class="mini-box"><small>성공확률(추정)</small><div>${(ex.winProb*100).toFixed(1)}%</div></div>
        <div class="mini-box"><small>MTF</small><div>${mtfLine}</div></div>
      `;

      content.innerHTML = `
        <b>현재는 “자주 실패한 패턴” 경고가 있어서 기본은 HOLD입니다.</b><br/>
        하지만 너 요청대로 <b>예측을 줄이지 않기 위해</b> 아래 버튼으로 “위험 감안 추적”을 허용합니다.<br/><br/>
        <b>복원된 TP/SL(강제추적 기준):</b><br/>
        - TP ${tpLine}<br/>
        - SL ${slLine}<br/><br/>
        <b>HOLD 사유:</b><br/>
        ${reasons}<br/><br/>
        <b>추가 정보:</b><br/>
        - ${calibLine}<br/>
        - ${regimeLine}<br/><br/>
        <b>정리:</b> “완전 차단” 대신 “경고 + 감점”으로 운영합니다.
      `;

      confirmBtn.disabled = false;
      confirmBtn.textContent = "위험 감안하고 추적 등록";
      confirmBtn.onclick = () => confirmTrack(forcePos);
    }else{
      grid.innerHTML = `
        <div class="mini-box"><small>판정</small><div>이번에는 예측 안 함</div></div>
        <div class="mini-box"><small>MTF</small><div>${mtfLine}</div></div>
        <div class="mini-box"><small>유사도 평균</small><div>${ex.simAvg.toFixed(1)}%</div></div>
        <div class="mini-box"><small>표본 수</small><div>${ex.simCount}개</div></div>
      `;
      content.innerHTML = `
        <b>이번에는 “보류”가 더 안전해요.</b><br/>
        ${reasons}<br/><br/>
        <b>추가 정보:</b><br/>
        - ${calibLine}<br/>
        - ${regimeLine}<br/><br/>
        <b>정리:</b> 애매할 때 억지로 진입하면 장기 승률이 내려가서, 이번은 패스합니다.
      `;
      confirmBtn.disabled = true;
      confirmBtn.textContent = "보류는 등록하지 않음";
      confirmBtn.onclick = () => {};
    }
  }else{
    grid.innerHTML = `
      <div class="mini-box"><small>진입가</small><div>$${pos.entry.toLocaleString(undefined,{maximumFractionDigits:6})}</div></div>
      <div class="mini-box"><small>성공확률(추정)</small><div>${(ex.winProb*100).toFixed(1)}%</div></div>
      <div class="mini-box"><small>목표가(TP)</small><div style="color:var(--success)">$${pos.tp.toLocaleString(undefined,{maximumFractionDigits:6})} (+${pos.tpPct.toFixed(2)}%)</div></div>
      <div class="mini-box"><small>손절가(SL)</small><div style="color:var(--danger)">$${pos.sl.toLocaleString(undefined,{maximumFractionDigits:6})} (-${pos.slPct.toFixed(2)}%)</div></div>
    `;

    const domMsg = (typeof ex.btcDom === "number")
      ? `BTC 도미넌스 ${ex.btcDom.toFixed(1)}% (최근 ${ex.btcDomUp>=0?"+":""}${ex.btcDomUp.toFixed(2)}p)`
      : `BTC 도미넌스: 데이터 없음`;

    content.innerHTML = `
      <b>근거 요약:</b><br/>
      - ${mtfLine}<br/>
      - ${confLine}<br/>
      - ${calibLine}<br/>
      - ${regimeLine}<br/>
      - 유사패턴 ${ex.simCount}개 · 평균 유사도 ${ex.simAvg.toFixed(1)}%<br/>
      - RSI ${ex.rsi.toFixed(1)} · MACD ${ex.macdHist.toFixed(4)}<br/>
      - 추세(EMA20/EMA50) ${ex.ema20 >= ex.ema50 ? "상승 우위" : "하락 우위"}<br/>
      - 거래량 흐름 ${ex.volTrend >= 0 ? "증가" : "감소"} · 엣지 ${(ex.edge*100).toFixed(1)}%<br/>
      - ${domMsg}<br/><br/>
      <b>정리:</b> 여러 기간(1H/4H/1D)이 같은 방향이면 더 믿을만해서, ${pos.type}로 제안합니다.
    `;

    confirmBtn.disabled = false;
    confirmBtn.textContent = "추적 시스템에 등록";
    confirmBtn.onclick = () => confirmTrack();
  }

  modal.style.display = "flex";
}

/* ==========================================================
   ✅ 통합 모달: 전략 카드 3개 보여주고 선택 → 등록
   ========================================================== */
function showResultModalAll(symbol, posMap){
  ensureRuntimeState();

  tempMulti = posMap || null;
  selectedMultiPos = null;

  const modal = document.getElementById("result-modal");
  const icon = document.getElementById("modal-icon");
  const title = document.getElementById("modal-title");
  const subtitle = document.getElementById("modal-subtitle");
  const grid = document.getElementById("modal-grid");
  const content = document.getElementById("modal-content");
  const cards = document.getElementById("multi-cards");
  const selectedEl = document.getElementById("multi-selected");
  const chooseBtn = document.getElementById("multi-choose");

  if(!modal || !icon || !title || !subtitle || !grid || !content || !cards || !selectedEl || !chooseBtn) return;

  _showMultiArea();

  icon.textContent = "🧠";
  title.textContent = "통합 예측 결과 (6전략)";
  title.style.color = "var(--primary)";
  subtitle.textContent = `${symbol} | 15M / 30M / 1H / 4H / 1D / 1W`;

  // 초기 안내
  grid.innerHTML = `
    <div class="mini-box"><small>안내</small><div>위 전략 카드에서 하나를 선택하세요</div></div>
    <div class="mini-box"><small>등록</small><div>선택 후 “추적 등록” 버튼을 누르세요</div></div>
    <div class="mini-box"><small>주의</small><div>HOLD는 원칙상 등록 불가</div></div>
    <div class="mini-box"><small>예외</small><div>패턴 경고 HOLD는 RISK로 허용</div></div>
  `;
  content.innerHTML = `
    <b>설명:</b> 단기/중기/장기 결과를 한 번에 보여주고, 너가 원하는 전략을 <b>선택해서</b> 추적 등록하는 방식입니다.
  `;

  selectedEl.textContent = "선택: 없음";
  chooseBtn.disabled = true;
  chooseBtn.style.opacity = "0.65";
  chooseBtn.textContent = "선택한 전략으로 추적 등록";

  const tfOrder = (typeof getMTFSet6==="function") ? getMTFSet6() : ["15","30","60","240","D","W"];
  const tfLabel = {
    "15":"초단기 15M",
    "30":"단기 30M",
    "60":"단기 1H",
    "240":"중기 4H",
    "D":"장기 1D",
    "W":"초장기 1W"
  };

  cards.innerHTML = tfOrder.map(tfRaw => {
    const p = posMap?.[tfRaw] || null;
    const label = tfLabel[tfRaw] || tfRaw;

    if(!p){
      return `
        <div class="mini-box" data-tf="${tfRaw}" style="opacity:.6;">
          <small>${label}</small>
          <div>데이터 부족</div>
          <div style="margin-top:6px; font-size:11px; color:var(--text-sub); font-weight:900;">
            캔들 부족/제한
          </div>
        </div>
      `;
    }

    const ex = p.explain || {};
    const wp = Number.isFinite(ex.winProb) ? (ex.winProb*100).toFixed(1) : "-";
    const edge = Number.isFinite(ex.edge) ? (ex.edge*100).toFixed(1) : "-";
    const sim = Number.isFinite(ex.simAvg) ? ex.simAvg.toFixed(1) : "-";
    const mtf = ex?.mtf ? `${ex.mtf.agree}/${(ex.mtf.votes||[]).length}(${(ex.mtf.votes||[]).join("/")})` : "-";
    const conf = ex?.conf?.tier ?? "-";

    const isHold = (p.type === "HOLD");
    const riskHold = isPatternBlockedHold(p);

    // HOLD인데 “패턴경고”가 있으면 RISK로 선택 허용(기존 지침 유지)
    const selectable = (!isHold) || (!!riskHold);

    const inferredType = (Number(ex.longP ?? 0.5) >= Number(ex.shortP ?? 0.5)) ? "LONG" : "SHORT";
    const showType = isHold ? (riskHold ? inferredType : "HOLD") : p.type;

    const riskTag = riskHold ? `<span style="margin-left:6px; color:var(--danger); font-weight:950;">RISK</span>` : "";
    const style = selectable ? "" : "opacity:.6; cursor:not-allowed;";
    const onClickAttr = selectable ? `onclick="selectMultiTf('${tfRaw}')"` : "";

    return `
      <div class="mini-box" data-tf="${tfRaw}" style="${style}" ${onClickAttr}>
        <small>${label}</small>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
          <div style="font-size:14px; font-weight:950;">${showType}${riskTag}</div>
          <div style="font-size:12px; font-weight:950; color:var(--text-sub);">${p.tf || tfRaw}</div>
        </div>
        <div style="margin-top:6px; font-size:12px; color:var(--text-sub); font-weight:900; line-height:1.4;">
          성공확률 ${wp}% · 엣지 ${edge}%<br/>
          유사도 ${sim}% · ${mtf} · ${conf}
        </div>
      </div>
    `;
  }).join("");

  modal.style.display = "flex";
}


// ✅ 호환: 과거 onclick="selectMulti(...)" 대응
function selectMulti(tfRaw){ return selectMultiTf(tfRaw); }

/* 카드 선택 */
function selectMultiTf(tfRaw){
  ensureRuntimeState();

  if(!tempMulti) return;
  const p = tempMulti[tfRaw];
  if(!p){
    toast("이 전략은 데이터가 부족합니다.", "warn");
    return;
  }

  // 중복 추적이면 선택 불가
  if(hasActivePosition(p.symbol, p.tfRaw)){
    toast("이미 같은 코인/같은 기간의 추적 포지션이 있습니다.", "warn");
    return;
  }

  // HOLD 처리 (패턴 리스크 HOLD만 예외적으로 허용)
  let chosen = p;
  if(p.type === "HOLD"){
    const riskHold = isPatternBlockedHold(p);
    if(riskHold){
      const forced = buildForcedTrackFromHold(p);
      if(forced){
        chosen = forced;
      }else{
        toast("RISK HOLD인데 TP/SL 복원이 실패했습니다.", "warn");
        return;
      }
    }else{
      toast("이 전략은 HOLD라서 등록할 수 없습니다.", "warn");
      // 그래도 상세는 보여주기 위해 단일 모달 렌더를 호출하지는 않음
      return;
    }
  }

  selectedMultiPos = chosen;

  // 카드 하이라이트
  const cards = document.getElementById("multi-cards");
  if(cards){
    const kids = Array.from(cards.querySelectorAll("[data-tf]"));
    for(const el of kids){
      el.style.border = "2px solid transparent";
    }
    const sel = cards.querySelector(`[data-tf="${tfRaw}"]`);
    if(sel) sel.style.border = "2px solid var(--primary)";
  }

  // 선택 표시
  const selectedEl = document.getElementById("multi-selected");
  if(selectedEl){
    selectedEl.textContent = `선택: ${p.tf} → ${chosen.type}${chosen._forceTrack ? " (RISK)" : ""}`;
  }

  // 버튼 활성화
  const chooseBtn = document.getElementById("multi-choose");
  if(chooseBtn){
    chooseBtn.disabled = false;
    chooseBtn.style.opacity = "1";
    chooseBtn.textContent = chosen._forceTrack ? "위험 감안하고 추적 등록" : "선택한 전략으로 추적 등록";
  }

  // 아래 단일 영역에 상세 표시(간단)
  const grid = document.getElementById("modal-grid");
  const content = document.getElementById("modal-content");
  if(grid && content){
    const ex = chosen.explain || {};
    const wp = Number.isFinite(ex.winProb) ? (ex.winProb*100).toFixed(1) : "-";
    const edge = Number.isFinite(ex.edge) ? (ex.edge*100).toFixed(1) : "-";
    const sim = Number.isFinite(ex.simAvg) ? ex.simAvg.toFixed(1) : "-";
    const mtfLine = ex?.mtf ? `MTF 합의: ${ex.mtf.agree}/${(ex.mtf.votes||[]).length} (${(ex.mtf.votes||[]).join("/")})` : "MTF: -";
    const confLine = ex?.conf ? `확신도: ${ex.conf.tier} (RR ${Number(ex.conf.rrUsed||RR).toFixed(2)})` : "확신도: -";

    grid.innerHTML = `
      <div class="mini-box"><small>진입가</small><div>$${chosen.entry.toLocaleString(undefined,{maximumFractionDigits:6})}</div></div>
      <div class="mini-box"><small>성공확률</small><div>${wp}%</div></div>
      <div class="mini-box"><small>TP</small><div style="color:var(--success)">$${chosen.tp.toLocaleString(undefined,{maximumFractionDigits:6})} (+${chosen.tpPct.toFixed(2)}%)</div></div>
      <div class="mini-box"><small>SL</small><div style="color:var(--danger)">$${chosen.sl.toLocaleString(undefined,{maximumFractionDigits:6})} (-${chosen.slPct.toFixed(2)}%)</div></div>
    `;

    content.innerHTML = `
      <b>선택한 전략 상세:</b><br/>
      - ${mtfLine}<br/>
      - ${confLine}<br/>
      - 유사도 ${sim}% · 엣지 ${edge}%<br/>
      ${chosen._forceTrack ? `<br/><b style="color:var(--danger);">RISK:</b> 패턴 경고 HOLD를 “감안 추적”으로 허용했습니다.` : ""}
    `;
  }
}

function confirmTrackSelected(){
  ensureRuntimeState();

  if(!selectedMultiPos){
    toast("먼저 전략을 선택하세요.", "warn");
    return;
  }
  confirmTrack(selectedMultiPos);
}

/* ==========================================================
   closeModal / confirmTrack
   ========================================================== */
function closeModal(){
  const modal = document.getElementById("result-modal");
  if(modal) modal.style.display = "none";

  tempPos = null;
  tempMulti = null;
  selectedMultiPos = null;

  // 멀티 잔상 제거
  try{ _hideMultiArea(); }catch(e){}
}

function confirmTrack(forcedPos=null){
  ensureRuntimeState();

  const posToUse = forcedPos || tempPos;
  if(!posToUse) return;

  ensurePosId(posToUse);

  if(posToUse.type === "HOLD" && !posToUse._forceTrack){
    return;
  }

  if(hasActivePosition(posToUse.symbol, posToUse.tfRaw)){
    toast("이미 같은 코인/같은 기간의 추적 포지션이 있습니다.", "warn");
    return;
  }

  const createdAt = Date.now();
  const expiryAt = createdAt + tfToMs(posToUse.tfRaw);

  state.activePositions.unshift({
    ...posToUse,
    id: posToUse.id,
    status: "ACTIVE",
    lastPrice: posToUse.entry,
    pnl: 0,
    mfePct: 0,
    createdAt,
    expiryAt
  });

  saveState();
  closeModal();
  renderTrackingList();
  updateStatsUI();
  updateCountdownTexts();

  if(posToUse._forceTrack){
    toast(`[${posToUse.symbol} ${posToUse.tf}] RISK 추적 등록 완료 (패턴경고 override)`, "warn");
  }
}

/* ==========================================================
   Tracking
   ========================================================== */
function trackPositions(symbol, currentPrice){
  ensureRuntimeState();

  let changed = false;
  const FEE_SAFE = (typeof FEE_PCT === "number" && Number.isFinite(FEE_PCT)) ? FEE_PCT : 0;

  for(let i = state.activePositions.length - 1; i >= 0; i--){
    const pos = state.activePositions[i];
    ensurePosId(pos);

    if(pos.symbol !== symbol) continue;

    pos.lastPrice = currentPrice;

    let pnlGross = 0;
    if(pos.type === "LONG"){
      pnlGross = ((currentPrice - pos.entry) / pos.entry) * 100;
    }else{
      pnlGross = ((pos.entry - currentPrice) / pos.entry) * 100;
    }
    const pnl = pnlGross - FEE_SAFE;
    pos.pnl = pnl;

    const favorable = (pos.type === "LONG")
      ? ((currentPrice - pos.entry) / pos.entry) * 100
      : ((pos.entry - currentPrice) / pos.entry) * 100;

    if(Number.isFinite(favorable)){
      if(typeof pos.mfePct !== "number") pos.mfePct = 0;
      if(favorable > pos.mfePct) pos.mfePct = favorable;
    }

    if(Number.isFinite(pos.mfePct) && pos.status === "ACTIVE"){
      if(pos.mfePct >= BE_TRIGGER_PCT){
        if(pos.type === "LONG"){
          const beSL = pos.entry * (1 + (BE_OFFSET_PCT/100));
          if(typeof pos.sl !== "number" || !Number.isFinite(pos.sl)) pos.sl = pos.entry;
          if(pos.sl < beSL) pos.sl = beSL;
        }else{
          const beSL = pos.entry * (1 - (BE_OFFSET_PCT/100));
          if(typeof pos.sl !== "number" || !Number.isFinite(pos.sl)) pos.sl = pos.entry;
          if(pos.sl > beSL) pos.sl = beSL;
        }
      }

      if(pos.mfePct >= TRAIL_START_PCT){
        if(pos.type === "LONG"){
          const trailSL = pos.entry * (1 + ((pos.mfePct - TRAIL_GAP_PCT)/100));
          if(pos.sl < trailSL) pos.sl = trailSL;
        }else{
          const trailSL = pos.entry * (1 - ((pos.mfePct - TRAIL_GAP_PCT)/100));
          if(pos.sl > trailSL) pos.sl = trailSL;
        }
      }
    }

    let close = false;
    let win = false;
    let exitPrice = null;
    let exitReason = "";

    if(pos.type === "LONG"){
      if(currentPrice >= pos.tp){ close = true; win = true; exitPrice = pos.tp; exitReason="TP"; }
      else if(currentPrice <= pos.sl){ close = true; win = false; exitPrice = pos.sl; exitReason="SL"; }
    }else{
      if(currentPrice <= pos.tp){ close = true; win = true; exitPrice = pos.tp; exitReason="TP"; }
      else if(currentPrice >= pos.sl){ close = true; win = false; exitPrice = pos.sl; exitReason="SL"; }
    }

    if(close){
      try{ recordTradeToPatternDB(pos, win); }catch(e){}
      try{ metaRecordFromPosition(pos, win, exitReason); }catch(e){}

      state.history.total++;
      if(win) state.history.win++;

      let pnlExitGross = 0;
      const px = (exitPrice ?? currentPrice);
      if(pos.type === "LONG"){
        pnlExitGross = ((px - pos.entry) / pos.entry) * 100;
      }else{
        pnlExitGross = ((pos.entry - px) / pos.entry) * 100;
      }
      const pnlExit = pnlExitGross - FEE_SAFE;

      const record = {
        id: Date.now(),
        symbol: pos.symbol,
        tf: pos.tf,
        tfRaw: pos.tfRaw,
        type: pos.type,
        entry: pos.entry,
        exit: px,
        pnlPct: pnlExit,
        mfePct: (typeof pos.mfePct === "number") ? pos.mfePct : 0,
        win,
        reason: exitReason,
        closedAt: Date.now()
      };
      state.closedTrades.unshift(record);
      state.closedTrades = state.closedTrades.slice(0, 30);

      state.activePositions.splice(i, 1);
      saveState();
      changed = true;

      toast(
        `[${pos.symbol} ${pos.tf}] 종료: ${win ? "성공" : "실패"} (${exitReason}) / 수익률 ${pnlExit.toFixed(2)}% / MFE ${record.mfePct.toFixed(2)}% (비용 -${FEE_SAFE.toFixed(2)}%)`,
        win ? "success" : "danger"
      );
    }else{
      changed = true;
    }
  }

  if(changed){
    saveState();
    renderTrackingList();
    renderClosedTrades();
    updateStatsUI();
  }
}

function renderTrackingList(){
  ensureRuntimeState();

  const container = document.getElementById("tracking-container");
  if(!container) return;

  ensureStrategyCountUI();
  updateStrategyCountUI();

  if(!state.activePositions.length){
    container.innerHTML = `
      <div style="text-align:center; padding:50px; color:var(--text-sub); font-weight:950;">
        <i class="fa-solid fa-radar" style="font-size:44px; opacity:.18;"></i><br><br>
        현재 추적 중인 포지션이 없습니다.<br/>
        왼쪽에서 코인을 고르고 “통합 예측(단·중·장)”을 눌러보세요.
      </div>
    `;
    return;
  }

  ensureExpiryOnAllPositions();
  ensureIdsOnAllPositions();

  container.innerHTML = state.activePositions.map(pos => {
    ensurePosId(pos);

    const isUp = pos.pnl >= 0;
    const color = isUp ? "var(--success)" : "var(--danger)";

    const denom = Math.max(Math.abs(pos.tp - pos.entry), 1e-9);
    const numer = (pos.type === "LONG")
      ? (pos.lastPrice - pos.entry)
      : (pos.entry - pos.lastPrice);

    let progress = (numer / denom) * 100;
    progress = clamp(progress, 0, 100);

    const ex = pos.explain || {};
    const tpPct = Number.isFinite(pos.tpPct) ? pos.tpPct : null;
    const slPct = Number.isFinite(pos.slPct) ? pos.slPct : null;

    const expiryAt = pos.expiryAt || getPosExpiryAt(pos);
    const remainMs = expiryAt - Date.now();
    const remainText = formatRemain(remainMs);

    const mtf = ex.mtf;
    const mtfMini = mtf
      ? `MTF ${mtf.agree}/${(mtf.votes||[]).length}(${(mtf.votes||[]).join("/")})`
      : `MTF -`;

    const confMini = ex.conf
      ? `CONF ${ex.conf.tier}(RR ${Number(ex.conf.rrUsed||RR).toFixed(2)})`
      : `CONF -`;

    const mfeMini = `MFE ${(typeof pos.mfePct === "number" ? pos.mfePct : 0).toFixed(2)}%`;

    const regimeMini = (typeof ex.trendStrength === "number")
      ? `TS ${ex.trendStrength.toFixed(2)}`
      : `TS -`;
    const volMini = (typeof ex.atrPct === "number")
      ? `ATR ${ex.atrPct.toFixed(2)}%`
      : `ATR -`;

    const explainLine =
      `남은시간 <b id="remain-${pos.id}">${remainText}</b> · ${mtfMini} · ${confMini} · ${mfeMini} · ${regimeMini} · ${volMini} · 유사패턴 ${ex.simCount ?? "-"}개 · 유사도 ${(ex.simAvg ?? 0).toFixed ? ex.simAvg.toFixed(1) : "-"}% · RSI ${(ex.rsi ?? 0).toFixed ? ex.rsi.toFixed(1) : "-"} · 엣지 ${((ex.edge ?? 0)*100).toFixed ? ((ex.edge ?? 0)*100).toFixed(1) : "-"}%`;

    const tpLine = tpPct !== null
      ? `$${pos.tp.toLocaleString(undefined,{maximumFractionDigits:6})} (+${tpPct.toFixed(2)}%)`
      : `$${pos.tp.toLocaleString(undefined,{maximumFractionDigits:6})}`;

    const slLine = slPct !== null
      ? `$${pos.sl.toLocaleString(undefined,{maximumFractionDigits:6})} (-${slPct.toFixed(2)}%)`
      : `$${pos.sl.toLocaleString(undefined,{maximumFractionDigits:6})}`;

    const riskTag = pos._forceTrack ? ` <span style="font-size:11px; font-weight:950; color:var(--danger);">(RISK)</span>` : "";

    return `
      <div class="position-card">
        <div class="card-header">
          <div class="card-symbol">
            ${pos.symbol} <span style="font-size:12px; color:var(--text-sub); font-weight:950;">${pos.tf}</span>${riskTag}
          </div>
          <div class="card-type ${pos.type === "LONG" ? "type-LONG" : "type-SHORT"}">${pos.type}</div>
        </div>

        <div class="card-grid">
          <div class="price-info">
            <span class="price-label">현재가</span>
            <span class="price-val">$${(pos.lastPrice||pos.entry).toLocaleString(undefined,{maximumFractionDigits:6})}</span>
          </div>

          <div>
            <div class="progress-text">
              <span style="color:${color}">수익률 ${pos.pnl.toFixed(2)}% <span style="color:var(--text-sub); font-weight:900;">(비용 반영)</span></span>
              <span>목표까지 ${progress.toFixed(1)}%</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill" style="width:${progress}%; background:${color};"></div>
            </div>
          </div>

          <div class="price-info">
            <span class="price-label">TP / SL</span>
            <span class="price-val" style="color:var(--success);">${tpLine}</span>
            <div style="height:4px;"></div>
            <span class="price-val" style="color:var(--danger);">${slLine}</span>
          </div>
        </div>

        <div class="card-foot">${explainLine}</div>
      </div>
    `;
  }).join("");

  updateCountdownTexts();
}

/* ==========================================================
   Closed trades + stats
   ========================================================== */
function renderClosedTrades(){
  ensureRuntimeState();

  const container = document.getElementById("history-container");
  const countEl = document.getElementById("history-count");
  if(!container || !countEl) return;

  const list = state.closedTrades || [];
  countEl.textContent = String(list.length);

  if(!list.length){
    container.innerHTML = `
      <div style="font-size:11px; color:var(--text-sub); font-weight:900; padding:4px 2px;">
        아직 종료된 기록이 없습니다.
      </div>
    `;
    return;
  }

  container.innerHTML = list.slice(0, 8).map(x => {
    const badge = x.win ? `<span class="badge-win">성공</span>` : `<span class="badge-lose">실패</span>`;
    const pnlColor = x.pnlPct >= 0 ? "var(--success)" : "var(--danger)";
    const mfeTxt = (typeof x.mfePct === "number") ? ` · MFE ${x.mfePct.toFixed(2)}%` : "";
    return `
      <div class="history-item">
        <div class="left">
          ${badge}
          <span>${x.symbol.replace("USDT","")} ${x.tf}</span>
          <span style="color:var(--text-sub); font-weight:950;">(${x.reason}${mfeTxt})</span>
        </div>
        <div style="text-align:right;">
          <div style="color:${pnlColor}; font-weight:950;">${x.pnlPct.toFixed(2)}%</div>
          <div style="color:var(--text-sub); font-size:10px; font-weight:900;">
            ${new Date(x.closedAt).toLocaleTimeString()}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function updateStatsUI(){
  ensureRuntimeState();

  const totalEl = document.getElementById("total-stat");
  const winEl = document.getElementById("win-stat");
  const activeEl = document.getElementById("active-stat");
  if(!totalEl || !winEl || !activeEl) return;

  totalEl.innerText = state.history.total;
  const rate = state.history.total > 0 ? (state.history.win / state.history.total) * 100 : 0;
  winEl.innerText = `${rate.toFixed(1)}%`;
  activeEl.innerText = state.activePositions.length;

  ensureStrategyCountUI();
  updateStrategyCountUI();
}

/* ==========================================================
   ✅ 통합 자동 스캔 (단/중/장 한 번에)
   - 결과 클릭 시: 통합 예측 모달(선택형)으로 연결
   ========================================================== */
async function autoScanUniverseAll(opts={}){
  ensureRuntimeState();

  const opToken = beginOperation("SCAN_ALL");

  const scanBtn = document.getElementById("scan-all-btn");
  const status = document.getElementById("scan-status");
  if(scanBtn) scanBtn.disabled = true;
  if(status) status.textContent = "통합 스캔 중...";

  // ✅ in-memory cache (클릭 결과가 스캔 결과와 달라지는 문제 방지)
  if(!window.__SCAN_DETAIL_CACHE) window.__SCAN_DETAIL_CACHE = new Map();

  try{
    const tfSet = getMTFSet6(); // 6 strategies
    const fullList = [];

    for(let i=0;i<state.universe.length;i++){
      checkCanceled(opToken);

      const coin = state.universe[i];
      if(status) status.textContent = `통합 스캔 중... (${i+1}/${state.universe.length})`;

      try{
        // ✅ 6TF 캔들을 한 번에 확보
        const candlesByTf = {};
        for(const tfRaw of tfSet){
          checkCanceled(opToken);
          candlesByTf[tfRaw] = await fetchCandles(coin.s, tfRaw, 380);
          // 취소 가능 딜레이(요청 폭주 방지)
          await sleepCancelable(Math.max(120, SCAN_DELAY_MS - 350), opToken);
        }

        // ✅ 6전략 계산(out)
        const out = {};
        for(const baseTfRaw of tfSet){
          const baseCandles = candlesByTf[baseTfRaw] || [];
          if(baseCandles.length < (SIM_WINDOW + FUTURE_H + 80)){
            out[baseTfRaw] = null;
            continue;
          }
          try{
            try{
        out[baseTfRaw] = buildSignalFromCandles_MTF(coin.s, baseTfRaw, candlesByTf, "6TF");
      }catch(err){
        console.warn("[LIST_PRED] buildSignal fail:", coin.s, baseTfRaw, err);
        out[baseTfRaw] = null;
      }
          }catch(err){
            console.warn("[SCAN] buildSignal fail:", coin.s, baseTfRaw, err);
            out[baseTfRaw] = null;
          }
        }

        // ✅ BEST 전략 선택(스캔 점수)
        let best = null;
        for(const tfRaw of tfSet){
          const pos = out[tfRaw];
          if(!pos) continue;

          const riskHold = isPatternBlockedHold(pos);
          const ex = pos.explain || {};
          const inferredType = (Number(ex.longP ?? 0.5) >= Number(ex.shortP ?? 0.5)) ? "LONG" : "SHORT";

          const item = {
            symbol: pos.symbol,
            tf: pos.tf,
            tfRaw: pos.tfRaw,
            type: (pos.type === "HOLD") ? inferredType : pos.type,
            winProb: Number(ex.winProb ?? 0.5),
            edge: Number(ex.edge ?? 0),
            mtfAgree: ex?.mtf?.agree ?? 1,
            mtfVotes: (ex?.mtf?.votes || []).join("/"),
            confTier: ex?.conf?.tier ?? "-",
            isRisk: !!riskHold,
            multi: true
          };

          // HOLD인데 RISK도 아니면 스킵(추천에서 빼기)
          if(pos.type === "HOLD" && !riskHold) continue;

          item._score = computeScanScore(item);
          if(!best || item._score > best._score) best = item;
        }

        // ✅ 목록에는 60종 전부 남긴다(추천이 없더라도 표에서 확인 가능)
        if(best){
          fullList.push({
            symbol: best.symbol,
            bestTf: best.tf,
            bestTfRaw: best.tfRaw,
            bestType: best.type,
            winProb: best.winProb,
            edge: best.edge,
            mtfAgree: best.mtfAgree,
            mtfVotes: best.mtfVotes,
            confTier: best.confTier,
            isRisk: best.isRisk
          });
        }else{
          // 추천/베스트가 없으면 HOLD로 기록(스캔 자체는 했다는 뜻)
          fullList.push({
            symbol: coin.s,
            bestTf: "-",
            bestTfRaw: "-",
            bestType: "HOLD",
            winProb: 0.5,
            edge: 0,
            mtfAgree: 0,
            mtfVotes: "",
            confTier: "-",
            isRisk: false
          });
        }

        // ✅ 상세 결과는 메모리 캐시에만 보관(클릭 시 스캔 결과 일치)
        // - best가 없더라도 out은 저장(모달에서 6전략 카드 표시용)
        window.__SCAN_DETAIL_CACHE.set(coin.s, { out, ts: Date.now() });
      }catch(e){}
    }

    // ✅ TOP 추천(화면 박스용) — 상위 12개
    fullList.sort((a,b)=> computeScanScore(b) - computeScanScore(a));
    state.lastScanResults = fullList.slice(0, 12).map(x=>({
      symbol:x.symbol,
      tf:x.bestTf,
      tfRaw:x.bestTfRaw,
      type:x.bestType,
      winProb:x.winProb,
      edge:x.edge,
      mtfAgree:x.mtfAgree,
      mtfVotes:x.mtfVotes,
      confTier:x.confTier,
      isRisk:x.isRisk,
      multi:true
    }));

    // ✅ 전체 목록(모달용)
    state.lastScanFullList = fullList;
    state.lastScanAt = Date.now();
    saveState();

    renderScanResults();
    // 모달이 열려있거나 요청되면 즉시 최신화
    try{ renderScanListModal?.(); }catch(e){}
    if(opts && opts.openModal){
      try{ openScanListModal(); }catch(e){}
    }
    if(status) status.textContent = state.lastScanResults.length ? "완료" : "추천 없음";
  }catch(e){
    if(String(e?.message || "").includes("CANCELLED")){
      toast("통합 자동 스캔이 취소되었습니다.", "warn");
      if(status) status.textContent = "취소됨";
      return;
    }
    console.error(e);
    toast("통합 자동 스캔 중 오류가 발생했습니다.", "danger");
    if(status) status.textContent = "오류";
  }finally{
    if(scanBtn){
      scanBtn.disabled = false;
      scanBtn.innerHTML = '<i class="fa-solid fa-binoculars"></i> 통합 자동 스캔(6전략)';
    }
    endOperation(opToken);
  }
}

function renderScanResults(){
  ensureRuntimeState();

  const container = document.getElementById("rec-container");
  if(!container) return;

  const list = state.lastScanResults || [];
  if(!list.length){
    container.innerHTML = `
      <div style="font-size:11px; color:var(--text-sub); font-weight:900; padding:6px 2px;">
        아직 추천 결과가 없습니다. “통합 자동 스캔”을 눌러주세요.
      </div>
    `;
    return;
  }

  container.innerHTML = list.map(item => {
    const pillClass = item.type === "LONG" ? "long" : "short";
    const prob = (item.winProb*100).toFixed(1);
    const edge = (item.edge*100).toFixed(1);
    const mtf = item.mtfVotes ? ` · MTF ${item.mtfAgree}/${item.mtfVotes.split("/").length}(${item.mtfVotes})` : "";
    const conf = item.confTier ? ` · ${item.confTier}` : "";
    const risk = item.isRisk ? ` · <span style="color:var(--danger); font-weight:950;">RISK</span>` : "";
    const tfTag = item.tf ? ` · ${item.tf}` : "";

    const click = `openFromScanListOrSidebar('${item.symbol}')`;

    return `
      <div class="rec-item" onclick="${click}">
        <div class="rec-left">
          ${item.symbol.replace("USDT","")}
          <span class="pill ${pillClass}">${item.type}</span>
        </div>
        <div class="rec-right">
          성공확률 ${prob}%<br/>
          엣지 ${edge}%${tfTag}${mtf}${conf}${risk}
        </div>
      </div>
    `;
  }).join("");
}

/* ==========================================================
   Backtest (원본 유지)
   ========================================================== */
function sliceCandlesUpToTime(candles, t){
  if(!Array.isArray(candles) || !candles.length) return [];
  if(candles[candles.length-1].t <= t) return candles.slice();
  let j = candles.length - 1;
  while(j >= 0 && candles[j].t > t) j--;
  return candles.slice(0, Math.max(0, j+1));
}

function shiftPosEntryTo(pos, newEntry){
  if(!pos || !Number.isFinite(newEntry)) return pos;
  const oldEntry = pos.entry;
  if(!Number.isFinite(oldEntry) || oldEntry <= 0) return pos;

  const d = newEntry - oldEntry;
  pos.entry = newEntry;

  if(pos.type !== "HOLD"){
    if(Number.isFinite(pos.tp)) pos.tp += d;
    if(Number.isFinite(pos.sl)) pos.sl += d;

    if(Number.isFinite(pos.tp)){
      pos.tpPct = Math.abs((pos.tp - pos.entry) / pos.entry) * 100;
    }
    if(Number.isFinite(pos.sl)){
      pos.slPct = Math.abs((pos.sl - pos.entry) / pos.entry) * 100;
    }
  }
  return pos;
}

async function runBacktest(){
  ensureRuntimeState();

  const opToken = beginOperation("BACKTEST");

  const btBtn = document.getElementById("bt-btn");
  if(btBtn){
    btBtn.disabled = true;
    btBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 백테스트...';
  }

  const box = document.getElementById("bt-box");
  if(box) box.classList.remove("show");

  try{
    checkCanceled(opToken);

    const tfSet = getMTFSet2(state.tf);
    const baseTf = tfSet[0];
    const otherTf = tfSet[1];

    const candlesBase = await fetchCandles(state.symbol, baseTf, EXTENDED_LIMIT);
    if(candlesBase.length < (SIM_WINDOW + FUTURE_H + 120)) throw new Error("캔들 데이터가 부족합니다.");

    let candlesOther = null;
    try{
      candlesOther = await fetchCandles(state.symbol, otherTf, EXTENDED_LIMIT);
    }catch(e){}

    let wins=0, total=0;
    let pnlSum=0;

    const end = candlesBase.length - (FUTURE_H + 20);
    const start = Math.max(SIM_WINDOW + 80, end - (BACKTEST_TRADES * 7));

    for(let idx = start; idx < end; idx += 7){
      checkCanceled(opToken);

      const sliceBase = candlesBase.slice(0, idx+1);
      if(sliceBase.length < (SIM_WINDOW + FUTURE_H + 80)) continue;

      const byTf = { [baseTf]: sliceBase };

      if(Array.isArray(candlesOther) && candlesOther.length > 120){
        const tRef = sliceBase[sliceBase.length-1].t;
        const sliceOther = sliceCandlesUpToTime(candlesOther, tRef);
        if(sliceOther.length >= (SIM_WINDOW + FUTURE_H + 80)){
          byTf[otherTf] = sliceOther;
        }
      }

      const pos = buildSignalFromCandles_MTF(state.symbol, baseTf, byTf, "2TF");
      if(pos.type === "HOLD") continue;

      const ex = pos.explain || {};
      if((ex.winProb ?? 0) < BT_MIN_PROB) continue;
      if((ex.edge ?? 0) < BT_MIN_EDGE) continue;
      if((ex.simAvg ?? 0) < BT_MIN_SIM) continue;

      const entryCandle = candlesBase[idx+1];
      if(!entryCandle || !Number.isFinite(entryCandle.o)) continue;
      shiftPosEntryTo(pos, entryCandle.o);

      const future = candlesBase.slice(idx+1, Math.min(idx+1+140, candlesBase.length));
      const outcome = simulateOutcome(pos, future);
      if(!outcome.resolved) continue;

      total++;
      if(outcome.win) wins++;
      pnlSum += outcome.pnlPct;

      if(total >= BACKTEST_TRADES) break;
    }

    const winRate = total ? (wins/total)*100 : 0;
    const avgPnl = total ? (pnlSum/total) : 0;

    const nEl = document.getElementById("bt-n");
    const wEl = document.getElementById("bt-win");
    const aEl = document.getElementById("bt-avg");
    const rEl = document.getElementById("bt-range");
    if(nEl) nEl.textContent = `${total}회`;
    if(wEl) wEl.textContent = `${winRate.toFixed(1)}%`;
    if(aEl) aEl.textContent = `${avgPnl.toFixed(2)}%`;

    const tfNameShow = baseTf === "60" ? "1H" : baseTf === "240" ? "4H" : "1D";
    if(rEl){
      rEl.textContent =
        `${state.symbol} · ${tfNameShow} · 최근 ${EXTENDED_LIMIT}캔들 (필터: 확률≥${Math.round(BT_MIN_PROB*100)}%, 엣지≥${Math.round(BT_MIN_EDGE*100)}%, 유사도≥${BT_MIN_SIM}%) · MTF(2TF) · ✅otherTF누수방지 · ✅다음시가진입 · ✅동봉캔들보수판정 · 비용 -${FEE_PCT.toFixed(2)}% 반영`;
    }

    if(box) box.classList.add("show");
  }catch(e){
    if(String(e?.message || "").includes("CANCELLED")){
      toast("백테스트가 취소되었습니다.", "warn");
      return;
    }
    console.error(e);
    toast("백테스트 중 오류가 발생했습니다.", "danger");
  }finally{
    endOperation(opToken);
    if(btBtn){
      btBtn.disabled = false;
      btBtn.innerHTML = '<i class="fa-solid fa-flask"></i> 백테스트';
    }
  }
}

function simulateOutcome(pos, futureCandles){
  for(const c of futureCandles){
    const hi = c.h, lo = c.l;

    if(pos.type === "LONG"){
      const hitTP = (hi >= pos.tp);
      const hitSL = (lo <= pos.sl);

      if(hitTP && hitSL){
        const pnl = ((pos.sl - pos.entry)/pos.entry)*100 - FEE_PCT;
        return { resolved:true, win:false, pnlPct:pnl, reason:"BOTH_SL" };
      }
      if(hitTP){
        const pnl = ((pos.tp - pos.entry)/pos.entry)*100 - FEE_PCT;
        return { resolved:true, win:true, pnlPct:pnl, reason:"TP" };
      }
      if(hitSL){
        const pnl = ((pos.sl - pos.entry)/pos.entry)*100 - FEE_PCT;
        return { resolved:true, win:false, pnlPct:pnl, reason:"SL" };
      }
    }else{
      const hitTP = (lo <= pos.tp);
      const hitSL = (hi >= pos.sl);

      if(hitTP && hitSL){
        const pnl = ((pos.entry - pos.sl)/pos.entry)*100 - FEE_PCT;
        return { resolved:true, win:false, pnlPct:pnl, reason:"BOTH_SL" };
      }
      if(hitTP){
        const pnl = ((pos.entry - pos.tp)/pos.entry)*100 - FEE_PCT;
        return { resolved:true, win:true, pnlPct:pnl, reason:"TP" };
      }
      if(hitSL){
        const pnl = ((pos.entry - pos.sl)/pos.entry)*100 - FEE_PCT;
        return { resolved:true, win:false, pnlPct:pnl, reason:"SL" };
      }
    }
  }
  return { resolved:false, win:false, pnlPct:0, reason:"NO_HIT" };
}

/* ==========================================================
   window 바인딩 (index.html onclick 호환)
   ========================================================== */
window.tryAuth = tryAuth;
window.setTF = setTF;


// 통합(단/중/장)
window.executeAnalysisAll = executeAnalysisAll;
window.quickAnalyzeAllAndShow = quickAnalyzeAllAndShow;
window.selectMultiTf = selectMultiTf;
window.selectMulti = selectMultiTf;
window.confirmTrackSelected = confirmTrackSelected;

// 스캔
window.autoScanUniverseAll = autoScanUniverseAll;
window.openScanListModal = openScanListModal;
window.closeScanListModal = closeScanListModal;
window.openFromScanListOrSidebar = openFromScanListOrSidebar;

// 백테스트/모달
window.runBacktest = runBacktest;
window.openBacktestModal = openBacktestModal;
window.closeBacktestModal = closeBacktestModal;
window.confirmTrack = confirmTrack;
window.closeModal = closeModal;

// 진행취소
window.cancelOperation = cancelOperation;

// 운영 버튼
window.resetStatsUIAndData = resetStatsUIAndData;
window.cancelAllTracking = cancelAllTracking;
window.resetAll = resetAll;


/* === YOPO FIX: 6TF + speed + reliability OVERRIDES (v3_6tf) === */
window.resetAll = resetAll;

/* === YOPO FIX: 6TF + speed + reliability OVERRIDES (v3_6tf) === */

function _resampleCandles(src, step){
  const out = [];
  if(!Array.isArray(src) || src.length < step) return out;
  for(let i=0;i+step-1<src.length;i+=step){
    const chunk = src.slice(i,i+step);
    const t = chunk[0].t, o = chunk[0].o, c = chunk[chunk.length-1].c;
    let h=-Infinity, l=Infinity, v=0;
    for(const x of chunk){ if(x.h>h) h=x.h; if(x.l<l) l=x.l; v += (x.v||0); }
    out.push({t,o,h,l,c,v});
  }
  return out;
}
function _resampleToW_fromD(daily){ return _resampleCandles(daily, 7); }

async function _fetchPack6(symbol){
  const [c15,c60,c240,cD] = await Promise.all([
    fetchCandlesSafe(symbol,"15",380),
    fetchCandlesSafe(symbol,"60",380),
    fetchCandlesSafe(symbol,"240",380),
    fetchCandlesSafe(symbol,"D",380),
  ]);
  const c30 = (c15 && c15.length>=2) ? _resampleCandles(c15,2) : [];
  const cW  = (cD && cD.length>=7) ? _resampleToW_fromD(cD) : [];
  return { "15":c15, "30":c30, "60":c60, "240":c240, "D":cD, "W":(cW.length?cW:cD) };
}

async function _poolMap(items, limit, worker, onProgress){
  const res = new Array(items.length);
  let i=0, active=0, done=0;
  return await new Promise((resolve)=>{
    const next=()=>{
      while(active<limit && i<items.length){
        const idx=i++;
        active++;
        Promise.resolve(worker(items[idx], idx)).then(v=>{ res[idx]=v; }).catch(_=>{ res[idx]=null; })
          .finally(()=>{ active--; done++; if(onProgress) onProgress(done, items.length, idx); if(done>=items.length) resolve(res); else next(); });
      }
    };
    next();
  });
}

// 통합 예측(6전략 전부 표시)
window.executeAnalysisAll = async function(){
  ensureRuntimeState();
  const opToken = beginOperation("ANALYSIS_ALL_6TF");
  const btn = document.getElementById("predict-all-btn");
  if(btn){ btn.disabled=true; btn.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> 통합 예측(6전략) 중...'; }
  try{
    checkCanceled(opToken);
    const symbol = state.symbol;
    const candlesByTf = await _fetchPack6(symbol);
    const tfs = (typeof getMTFSet6==="function") ? getMTFSet6() : ["15","30","60","240","D","W"];
    const out = {};
    for(const tfRaw of tfs){
      checkCanceled(opToken);
      const baseCandles = candlesByTf[tfRaw] || [];
      if(!baseCandles || baseCandles.length < (SIM_WINDOW + FUTURE_H + 40)){ out[tfRaw]=null; continue; }
      out[tfRaw] = buildSignalFromCandles_MTF(symbol, tfRaw, candlesByTf, "6TF");
      state.lastSignalAt[`${symbol}|${tfRaw}`] = Date.now();
    }
    saveState();
    showResultModalAll(symbol, out);
  }catch(e){
    if(String(e?.message||"").includes("CANCELLED")){ toast("진행 중 작업이 취소되었습니다.","warn"); return; }
    console.error(e); toast("통합 예측 중 오류가 발생했습니다. (API 지연/제한 가능)","danger");
  }finally{
    endOperation(opToken);
    if(btn){ btn.disabled=false; btn.innerHTML='<i class="fa-solid fa-wand-magic-sparkles"></i> 통합 예측(6전략) 실행'; }
  }
};

// index onclick 호환
window.executeAnalysis = async function(){ return window.executeAnalysisAll(); };
window.autoScanUniverse = async function(){ return window.autoScanUniverseAll(); };

// 통합 스캔(6전략) — 1회 전체 스캔 유지 + 속도 최적화(동시성/파생TF)
window.autoScanUniverseAll = async function(){
  ensureRuntimeState();
  const opToken = beginOperation("SCAN_ALL_6TF");
  const scanBtn = document.getElementById("scan-all-btn");
  const status = document.getElementById("scan-status");
  if(scanBtn) scanBtn.disabled=true;
  if(status) status.textContent="통합 스캔(6전략) 시작...";
  try{
    const tfs = (typeof getMTFSet6==="function") ? getMTFSet6() : ["15","30","60","240","D","W"];
    const perTf = {}; for(const tf of tfs) perTf[tf]=[];
    const uni = Array.isArray(state.universe)?state.universe:[];
    const limit = 6;
    await _poolMap(uni, limit, async (coin)=>{
      const sym = coin?.s || coin?.symbol || coin;
      const candlesByTf = await _fetchPack6(sym);
      for(const tfRaw of tfs){
        const baseCandles = candlesByTf[tfRaw] || [];
        if(!baseCandles || baseCandles.length < (SIM_WINDOW + FUTURE_H + 40)) continue;
        const pos = buildSignalFromCandles_MTF(sym, tfRaw, candlesByTf, "6TF");
        const riskHold = (typeof isPatternBlockedHold==="function") ? isPatternBlockedHold(pos) : false;
        if(pos.type==="HOLD" && !riskHold) continue;

        const ex = pos.explain || {};
        const inferredType = (Number(ex.longP ?? 0.5) >= Number(ex.shortP ?? 0.5)) ? "LONG" : "SHORT";
        perTf[tfRaw].push({
          symbol: pos.symbol, tf: pos.tf,
          type: (pos.type==="HOLD") ? inferredType : pos.type,
          score: Number(ex.edge ?? 0),
          winProb: Number(ex.winProb ?? ex.winP ?? 0),
          entry: pos.entry, tp: pos.tp, sl: pos.sl,
          explain: pos.explain || {}
        });
      }
      return true;
    }, (done,total)=>{
      if(status) status.textContent = `통합 스캔(6전략) 진행중... (${done}/${total})`;
    });

    for(const tf of tfs){
      perTf[tf].sort((a,b)=> (b.score||0)-(a.score||0));
      perTf[tf] = perTf[tf].slice(0, 30);
    }
    state.scanResults = perTf;
    saveState();
    if(typeof showScanModalAll==="function") showScanModalAll(perTf);
    if(status) status.textContent="통합 스캔 완료";
    toast("통합 스캔(6전략) 완료", "success");
  }catch(e){
    if(String(e?.message||"").includes("CANCELLED")){ toast("스캔이 취소되었습니다.","warn"); return; }
    console.error(e); toast("통합 스캔 중 오류가 발생했습니다. (API 지연/제한 가능)","danger");
  }finally{
    endOperation(opToken);
    if(scanBtn) scanBtn.disabled=false;
  }
};


/* ==========================================================
   ✅ Scan List Modal (전체 목록)
   ========================================================== */
function openScanListModal(){
  const m = document.getElementById("scan-list-modal");
  if(m) m.style.display = "flex";
  renderScanListModal();
}
function closeScanListModal(){
  const m = document.getElementById("scan-list-modal");
  if(m) m.style.display = "none";
}
function renderScanListModal(){
  ensureRuntimeState();
  const body = document.getElementById("scanlist-body");
  const sub = document.getElementById("scanlist-sub");
  if(!body) return;

  let list = state.lastScanFullList || [];
  if((!list || !list.length) && Array.isArray(state.lastScanResults) && state.lastScanResults.length){
    // 폴백: TOP 결과만이라도 표에 노출
    list = state.lastScanResults.map(x=>({
      symbol:x.symbol,
      bestTf:x.tf,
      bestTfRaw:x.tfRaw,
      bestType:x.type,
      winProb:x.winProb,
      edge:x.edge,
      mtfAgree:x.mtfAgree,
      mtfVotes:x.mtfVotes,
      confTier:x.confTier,
      isRisk:x.isRisk
    }));
  }
  const ts = state.lastScanAt ? new Date(state.lastScanAt) : null;
  if(sub){
    sub.textContent = ts ? `업데이트: ${ts.toLocaleString()} · 총 ${list.length}개` : `총 ${list.length}개`;
  }

  if(!list.length){
    body.innerHTML = `<tr><td colspan="7" style="padding:14px; color:var(--text-sub); font-weight:900;">아직 스캔 결과가 없습니다.</td></tr>`;
    return;
  }

  body.innerHTML = list.map(row=>{
    const pill = row.bestType === "LONG" ? "long" : "short";
    const prob = (Number(row.winProb||0.5)*100).toFixed(1) + "%";
    const edge = (Number(row.edge||0)*100).toFixed(1) + "%";
    const votes = row.mtfVotes ? `${row.mtfAgree}/${(row.mtfVotes.split('/').length)} (${row.mtfVotes})` : "-";
    const risk = row.isRisk ? "RISK" : "-";
    return `
      <tr onclick="openFromScanListOrSidebar('${row.symbol}')">
        <td style="font-weight:950;">${row.symbol}</td>
        <td><span class="badge-pill ${pill}">${row.bestTf} ${row.bestType}</span></td>
        <td>${prob}</td>
        <td>${edge}</td>
        <td>${votes}</td>
        <td>${row.confTier || "-"}</td>
        <td style="color:${row.isRisk ? 'var(--danger)' : 'var(--text-sub)'}; font-weight:950;">${risk}</td>
      </tr>
    `;
  }).join("");
}

// ✅ 사이드바 추천/스캔목록에서 클릭하면: “스캔 때 계산한 결과”를 우선 보여준다.
async function openFromScanListOrSidebar(symbol){
  ensureRuntimeState();

  const opToken = beginOperation("ANALYSIS_ALL");

  try{
    switchCoin(symbol);
    saveState();
    initChart();

    // 1) scan-cache 우선
    const cache = window.__SCAN_DETAIL_CACHE?.get(symbol);
    if(cache && cache.out){
      showResultModalAll(symbol, cache.out);
      endOperation(opToken);
      return;
    }

    // 2) 없으면 정상 통합 예측(6TF)
    const tfSet = getMTFSet6();
    const candlesByTf = {};
    for(const tfRaw of tfSet){
      checkCanceled(opToken);
      candlesByTf[tfRaw] = await fetchCandles(symbol, tfRaw, EXTENDED_LIMIT);
    }

    const out = {};
    for(const baseTfRaw of tfSet){
      const baseCandles = candlesByTf[baseTfRaw] || [];
      if(baseCandles.length < (SIM_WINDOW + FUTURE_H + 80)){
        out[baseTfRaw] = null;
        continue;
      }
      try{
        try{
        out[baseTfRaw] = buildSignalFromCandles_MTF(symbol, baseTfRaw, candlesByTf, "6TF");
      }catch(err){
        console.warn("[PRED] buildSignal fail:", symbol, baseTfRaw, err);
        out[baseTfRaw] = null;
      }
      }catch(err){
        console.warn("[ANALYSIS_ALL] buildSignal fail:", symbol, baseTfRaw, err);
        out[baseTfRaw] = null;
      }
    }

    showResultModalAll(symbol, out);
  }catch(e){
    if(String(e?.message || "").includes("CANCELLED")){
      toast("진행 중 작업이 취소되었습니다.", "warn");
      return;
    }
    console.error(e);
    toast("통합 추천 분석 중 오류가 발생했습니다.", "danger");
  }finally{
    endOperation(opToken);
  }
}

/* ==========================================================
   ✅ Backtest Modal (전체 코인/전체 전략)
   ========================================================== */
function openBacktestModal(){
  const m = document.getElementById("bt-modal");
  if(m) m.style.display = "flex";
}
function closeBacktestModal(){
  const m = document.getElementById("bt-modal");
  if(m) m.style.display = "none";
}

async function runBacktest(opts={}){
  ensureRuntimeState();

  const opToken = beginOperation("BACKTEST");

  openBacktestModal();

  const btBtn = document.getElementById("bt-btn");
  if(btBtn){
    btBtn.disabled = true;
    btBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 백테스트...';
  }

  const body = document.getElementById("bt-body");
  const sum = document.getElementById("bt-summary");
  if(body) body.innerHTML = `<tr><td colspan="6" style="padding:14px; color:var(--text-sub); font-weight:900;">진행 중...</td></tr>`;
  if(sum) sum.textContent = "진행 중...";

  try{
    const tfSet = getMTFSet6();
    const rows = [];

    let done=0;
    const totalJobs = (state.universe.length || 0) * tfSet.length;
    const btProg = document.getElementById("bt-progress");
    if(btProg) btProg.textContent = totalJobs ? "0%" : "-";

    for(let i=0;i<state.universe.length;i++){
      checkCanceled(opToken);
      const sym = state.universe[i]?.s;
      if(!sym) continue;

      // ✅ 심볼당 6TF 캔들 1회 로드(재사용)
      const byTf = {};
      for(const tfRaw of tfSet){
        checkCanceled(opToken);
        byTf[tfRaw] = await fetchCandles(sym, tfRaw, EXTENDED_LIMIT);
        await sleepCancelable(80, opToken);
      }

      for(const baseTf of tfSet){
        checkCanceled(opToken);

        const tf2 = getMTFSet2(baseTf);
        const otherTf = tf2[1];

        const candlesBase = byTf[baseTf] || [];
        const candlesOther = byTf[otherTf] || [];

        let wins=0, total=0, pnlSum=0;

        if(candlesBase.length >= (SIM_WINDOW + FUTURE_H + 120)){
          const end = candlesBase.length - (FUTURE_H + 20);
          const start = Math.max(SIM_WINDOW + 80, end - (BACKTEST_TRADES * 7));

          for(let idx = start; idx < end; idx += 7){
            checkCanceled(opToken);

            const sliceBase = candlesBase.slice(0, idx+1);
            if(sliceBase.length < (SIM_WINDOW + FUTURE_H + 80)) continue;

            const local = { [baseTf]: sliceBase };

            if(Array.isArray(candlesOther) && candlesOther.length > 120){
              const tRef = sliceBase[sliceBase.length-1].t;
              const sliceOther = sliceCandlesUpToTime(candlesOther, tRef);
              if(sliceOther.length >= (SIM_WINDOW + FUTURE_H + 80)){
                local[otherTf] = sliceOther;
              }
            }

            const pos = buildSignalFromCandles_MTF(sym, baseTf, local, "2TF");
            if(pos.type === "HOLD") continue;

            const ex = pos.explain || {};
            if((ex.winProb ?? 0) < BT_MIN_PROB) continue;
            if((ex.edge ?? 0) < BT_MIN_EDGE) continue;
            if((ex.simAvg ?? 0) < BT_MIN_SIM) continue;

            const entryCandle = candlesBase[idx+1];
            if(!entryCandle || !Number.isFinite(entryCandle.o)) continue;
            shiftPosEntryTo(pos, entryCandle.o);

            const future = candlesBase.slice(idx+1, Math.min(idx+1+140, candlesBase.length));
            const outcome = simulateOutcome(pos, future);
            if(!outcome.resolved) continue;

            total++;
            if(outcome.win) wins++;
            pnlSum += outcome.pnlPct;

            if(total >= BACKTEST_TRADES) break;
          }
        }

        const winRate = total ? (wins/total)*100 : 0;
        const avgPnl = total ? (pnlSum/total) : 0;

        rows.push({
          symbol: sym,
          tf: tfName(baseTf),
          n: total,
          win: winRate,
          avg: avgPnl,
          memo: (total===0) ? "표본 0 (API/필터/HOLD)" : ""
        });

        done++;
        if(btProg){
          const pct = totalJobs ? Math.floor((done/totalJobs)*100) : 0;
          btProg.textContent = `${pct}%`;
        }
        if(sum){
          sum.textContent = `진행: ${done}/${totalJobs} · 현재 행: ${sym} ${tfName(baseTf)}`;
        }
      }
    }

    // ✅ 정렬: 표본 많은 순 → 승률 높은 순
    rows.sort((a,b)=> (b.n-a.n) || (b.win-a.win));

    if(body){
      body.innerHTML = rows.map(r=>{
        return `
          <tr>
            <td style="font-weight:950;">${r.symbol}</td>
            <td>${r.tf}</td>
            <td>${r.n}</td>
            <td>${r.win.toFixed(1)}%</td>
            <td>${r.avg.toFixed(2)}%</td>
            <td style="color:var(--text-sub);">${r.memo}</td>
          </tr>
        `;
      }).join("");
    }

    if(sum){
      const avgWin = rows.filter(r=>r.n>0).reduce((a,r)=>a+r.win,0) / Math.max(1, rows.filter(r=>r.n>0).length);
      const cnt = rows.filter(r=>r.n>0).length;
      sum.textContent = `완료 · 유효 조합 ${cnt}/${rows.length} · 평균 승률 ${Number.isFinite(avgWin)?avgWin.toFixed(1):"0.0"}% · 정렬(표본→승률)`;
    }
  }catch(e){
    if(String(e?.message || "").includes("CANCELLED")){
      toast("백테스트가 취소되었습니다.", "warn");
      if(sum) sum.textContent = "취소됨";
      return;
    }
    console.error(e);
    toast("백테스트 중 오류가 발생했습니다.", "danger");
    if(sum) sum.textContent = "오류";
  }finally{
    if(btBtn){
      btBtn.disabled = false;
      btBtn.innerHTML = '<i class="fa-solid fa-flask"></i> 백테스트';
    }
    const btProg = document.getElementById("bt-progress");
    if(btProg) btProg.textContent = "";
    endOperation(opToken);
  }
}


/* =========================
   ✅ FINAL WINDOW BINDINGS (ensure latest functions are wired)
   - 중간에 함수가 재정의되면, 기존 window 바인딩이 '옛 함수'를 가리킬 수 있음
   - 그래서 파일 맨 끝에서 한번 더 바인딩을 강제한다.
========================= */
;(function(){
  try{
    // 예측/스캔 쪽은 window.executeAnalysisAll / window.autoScanUniverseAll 가 이미 wrapper로 덮였을 수 있으니 건드리지 않음
    window.runBacktest = runBacktest;
    window.openBacktestModal = openBacktestModal;
    window.closeBacktestModal = closeBacktestModal;

    window.openScanListModal = openScanListModal;
    window.closeScanListModal = closeScanListModal;
    window.openFromScanListOrSidebar = openFromScanListOrSidebar;

    window.cancelOperation = cancelOperation;
  }catch(e){ console.warn("FINAL BINDINGS fail", e); }
})();
