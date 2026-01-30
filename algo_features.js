/*************************************************************
 * YOPO AI PRO — algo_features.js (SERVER)
 * 역할: algo_core 보조 (패턴 시그니처/진화기억 키/감쇠 통계/확률 보정)
 * ⚠️ 이 파일은 Render 서버에서만 사용 (브라우저 금지)
 *************************************************************/

const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));

/** 숫자를 step 단위로 binning (안정적/굵게) */
function bin(x, step){
  const v = Number.isFinite(x) ? x : 0;
  const s = Math.max(Number(step)||1e-9, 1e-9);
  return Math.floor(v / s);
}

/**
 * 패턴 시그니처 (레짐×TF×방향×패턴)
 * - 너무 세밀하면 표본이 쪼개지므로 "굵게" 묶는다.
 */
export function buildPatternKey({ regime, tf, action, coreFeatures }){
  const r = String(regime || "UNK");
  const t = String(tf || "UNK");
  const a = String(action || "HOLD");

  const f = coreFeatures || {};
  const volB   = bin(f.vol ?? 0, 0.004);     // 변동성
  const trB    = bin(f.trend ?? 0, 0.01);    // 추세(기간수익률)
  const rngB   = bin(f.range ?? 0, 0.02);    // 레인지 폭
  const devB   = bin(f.dev ?? 0, 0.01);      // 평균이탈
  const brkB   = bin((f.breakoutUp ?? 0) - (f.breakoutDn ?? 0), 0.003); // 돌파 방향성

  return `${r}|${t}|${a}|v${volB}|t${trB}|r${rngB}|d${devB}|b${brkB}`;
}

/**
 * Upstash 이벤트 배열 -> 감쇠 통계 생성
 * event: {ts, symbol, tf, action, win, regime, meta:{...}}
 */
export function buildDecayedStats(events, opts={}){
  const halfLifeDays = Number(opts.halfLifeDays ?? 7);
  const maxAgeDays = Number(opts.maxAgeDays ?? 60);

  const now = Date.now();
  const stats = new Map(); // key -> {w, l}

  for(const e of (events||[])){
    const ts = Number(e?.ts || 0);
    if(!ts) continue;

    const ageDays = (now - ts) / (24*3600*1000);
    if(ageDays < 0) continue;
    if(ageDays > maxAgeDays) continue;

    const w = Math.pow(0.5, ageDays / Math.max(halfLifeDays, 1e-9));

    const key = String(e?.meta?.patternKey || e?.metaKey || e?.key || "");
    if(!key) continue;

    const cur = stats.get(key) || { w:0, l:0 };
    if(e?.win) cur.w += w;
    else cur.l += w;
    stats.set(key, cur);
  }

  // map -> plain object
  const out = {};
  for(const [k,v] of stats.entries()){
    const n = v.w + v.l;
    const wr = n>0 ? (v.w/n) : 0.5;
    out[k] = { n, w:v.w, l:v.l, wr };
  }
  return out;
}

/**
 * 진화기억으로 확률 보정
 * - 필터로 "예측을 줄이는"게 아니라, 확률을 더 똑똑하게 만드는 보정
 */
export function applyEvolveAdjust({ pLong, pShort, key, memoryStats, priorN=18, priorWR=0.55, alphaMax=0.18, minSamples=10 }){
  let pl = Number(pLong); let ps = Number(pShort);
  if(!Number.isFinite(pl) || !Number.isFinite(ps)) return { pLong, pShort, evolve:null };

  const rec = memoryStats?.[key] || null;
  if(!rec || !Number.isFinite(rec.n) || rec.n <= 0){
    return { pLong:pl, pShort:ps, evolve:null };
  }

  // 베이지안 스무딩
  const n = rec.n;
  const wr = (rec.w + priorWR*priorN) / (n + priorN);

  // 샘플이 쌓일수록 alpha ↑ (최대 alphaMax)
  const alpha = (n < minSamples) ? 0 : Math.min(alphaMax, (n - minSamples) / 80 * alphaMax);

  // “현재 선택 방향”에만 반영 (LONG이면 LONG 확률만, SHORT이면 SHORT 확률만)
  if(pl >= ps){
    pl = clamp((1-alpha)*pl + alpha*wr, 0.01, 0.99);
    ps = clamp(1 - pl, 0.01, 0.99);
  }else{
    ps = clamp((1-alpha)*ps + alpha*wr, 0.01, 0.99);
    pl = clamp(1 - ps, 0.01, 0.99);
  }

  return { pLong:pl, pShort:ps, evolve:{ n, wr, alpha } };
}
