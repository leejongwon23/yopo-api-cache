/**
 * YOPO AI PRO (Render) — server.js  ✅ v4 (SERVER-ENGINE)
 * 목표:
 * - 브라우저 과부하/지연을 끝내기 위해 "계산(자동스캔/백테스트/통합예측)"을 서버가 수행
 * - 브라우저는 결과 표시(UI)만 담당
 *
 * ✅ 제공 라우트
 * - GET  /                     : 헬스체크
 * - GET  /ping                 : keepalive
 * - GET  /api/cg/global         : CoinGecko global (캐시)
 * - GET  /api/cg/markets        : CoinGecko markets (쿼리 전달, 캐시)
 * - GET  /api/binance/fapi/klines     : Binance Vision futures klines (쿼리 전달, 캐시)
 * - GET  /api/binance/spot/klines     : Binance Vision spot klines (쿼리 전달, 캐시)
 * - GET  /api/binance/fapi/ticker24hr : Binance Vision futures 24hr ticker (캐시)
 *
 * ✅ 계산 엔진(서버)
 * - POST /api/scan      : TOP(추천) + FULL(전체표) 계산
 * - POST /api/backtest  : 백테스트 계산
 * - POST /api/predict   : 통합예측(6전략) 계산
 *
 * ⚠️ 주의
 * - Render Free는 슬립될 수 있음 → /ping + 브라우저 keepalive로 깨움
 * - 서버가 죽으면(또는 네트워크 문제) 브라우저 폴백(직접 호출)이 동작하도록 클라이언트가 설계됨
 */

import express from "express";
import fs from "fs";
import path from "path";
import vm from "vm";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "2mb" }));

function okCors(res){
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
}
app.use((req,res,next)=>{
  okCors(res);
  if(req.method === "OPTIONS") return res.status(200).send("ok");
  next();
});

app.get("/", (req,res)=> res.type("text/plain").send("YOPO Render Engine OK"));
app.get("/ping", (req,res)=> res.type("text/plain").send("pong"));

// ----- TTL (초)
const TTL = {
  cgGlobal: 60,
  cgMarkets: 60,
  binanceKline: 10,
  binanceTicker24: 3,
};

// ----- 간단 메모리 캐시 (Render Free에서도 동작)
const mem = new Map(); // key -> { exp:number, status:number, headers:object, body:Buffer }

function nowMs(){ return Date.now(); }

async function fetchUpstream(url){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), 15000);
  try{
    const r = await fetch(url, {
      method:"GET",
      headers:{
        "user-agent":"YOPO-Render-Engine",
        "accept":"*/*",
      },
      signal: ctrl.signal
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const headers = {};
    for(const [k,v] of r.headers.entries()){
      headers[k.toLowerCase()] = v;
    }
    return { ok:r.ok, status:r.status, headers, body:buf };
  } finally {
    clearTimeout(t);
  }
}

async function fetchAndCache(key, upstreamUrl, ttlSec){
  const hit = mem.get(key);
  if(hit && hit.exp > nowMs()) return hit;

  const r = await fetchUpstream(upstreamUrl);

  // 실패는 캐시 X
  if(!r.ok){
    return {
      exp: nowMs()+1000,
      status: r.status,
      headers: Object.assign({}, r.headers, { "access-control-allow-origin":"*" }),
      body: r.body
    };
  }

  const out = {
    exp: nowMs() + ttlSec*1000,
    status: r.status,
    headers: Object.assign({}, r.headers, {
      "cache-control": `public, max-age=${ttlSec}`,
      "access-control-allow-origin":"*",
      "content-type": r.headers["content-type"] || "application/json; charset=utf-8"
    }),
    body: r.body
  };
  mem.set(key, out);
  return out;
}

function sendCached(res, pack){
  for(const [k,v] of Object.entries(pack.headers || {})){
    try{ res.setHeader(k, v); }catch(e){}
  }
  res.status(pack.status || 200).send(pack.body);
}

// ---------- Proxy/cache routes
app.get("/api/cg/global", async (req,res)=>{
  const key = "cg:global";
  const upstream = "https://api.coingecko.com/api/v3/global";
  const pack = await fetchAndCache(key, upstream, TTL.cgGlobal);
  sendCached(res, pack);
});

app.get("/api/cg/markets", async (req,res)=>{
  const key = "cg:markets:" + (req.originalUrl || "");
  const upstream = "https://api.coingecko.com/api/v3/coins/markets" + (req.url.replace("/api/cg/markets","") || "");
  const pack = await fetchAndCache(key, upstream, TTL.cgMarkets);
  sendCached(res, pack);
});

app.get("/api/binance/fapi/klines", async (req,res)=>{
  const key = "bz:fapi:klines:" + (req.originalUrl || "");
  const upstream = "https://data-api.binance.vision/fapi/v1/klines" + (req.url.replace("/api/binance/fapi/klines","") || "");
  const pack = await fetchAndCache(key, upstream, TTL.binanceKline);
  sendCached(res, pack);
});

app.get("/api/binance/spot/klines", async (req,res)=>{
  const key = "bz:spot:klines:" + (req.originalUrl || "");
  const upstream = "https://data-api.binance.vision/api/v3/klines" + (req.url.replace("/api/binance/spot/klines","") || "");
  const pack = await fetchAndCache(key, upstream, TTL.binanceKline);
  sendCached(res, pack);
});

app.get("/api/binance/fapi/ticker24hr", async (req,res)=>{
  const key = "bz:fapi:ticker24";
  const upstream = "https://data-api.binance.vision/fapi/v1/ticker/24hr";
  const pack = await fetchAndCache(key, upstream, TTL.binanceTicker24);
  sendCached(res, pack);
});

// ==========================================================
// ✅ SERVER ENGINE: load client algorithms in VM (no rewrite)
// - algo_core.js    : app.core.js 복사본
// - algo_features.js: app.features.js 복사본 (backtest helpers 포함)
// ==========================================================
const __dirname = path.dirname(new URL(import.meta.url).pathname);

function loadAlgoContext(){
  const corePath = path.join(__dirname, "algo_core.js");
  const featPath = path.join(__dirname, "algo_features.js");

  const coreCode = fs.readFileSync(corePath, "utf-8");
  const featCode = fs.readFileSync(featPath, "utf-8");

  // 최소 스텁(로드 시 크래시 방지)
  const dummyEl = ()=>({
    style:{},
    classList:{ add(){}, remove(){}, contains(){ return false; } },
    innerHTML:"",
    textContent:"",
    disabled:false,
    value:"",
    focus(){},
    appendChild(){},
    querySelector(){ return null; },
  });

  const ctx = {
    console,
    Math,
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    // browser stubs
    window: {},
    document: {
      getElementById(){ return dummyEl(); },
      createElement(){ return dummyEl(); },
      body: dummyEl()
    },
    localStorage: {
      getItem(){ return null; },
      setItem(){},
      removeItem(){},
    },
    // prevent accidental network calls from loaded code
    fetch: undefined,
  };

  const context = vm.createContext(ctx);

  // load core + features into same context
  vm.runInContext(coreCode, context, { timeout: 1000 });
  vm.runInContext(featCode, context, { timeout: 1000 });

  // expose needed functions (guard)
  const need = [
    "getMTFSet6",
    "getMTFSet2",
    "buildSignalFromCandles_MTF",
    "isPatternBlockedHold",
    "computeScanScore",
    "shiftPosEntryTo",
    "simulateOutcome",
    "SIM_WINDOW",
    "FUTURE_H",
    "EXTENDED_LIMIT",
    "BACKTEST_TRADES",
    "BT_MIN_PROB",
    "BT_MIN_EDGE",
    "BT_MIN_SIM",
    "FEE_PCT"
  ];
  for(const k of need){
    if(!(k in context)){
      throw new Error("ALGO_MISSING_" + k);
    }
  }
  return context;
}

let ALGO = null;
try{
  ALGO = loadAlgoContext();
  console.log("[ALGO] loaded OK");
}catch(e){
  console.error("[ALGO] load failed:", e);
  // 서버는 살아있되, 엔진 라우트는 에러로 응답하게 처리
}

function parseKlines(raw){
  if(!Array.isArray(raw)) return [];
  return raw.map(k=>({
    t: Number(k?.[0]),
    o: Number(k?.[1]),
    h: Number(k?.[2]),
    l: Number(k?.[3]),
    c: Number(k?.[4]),
    v: Number(k?.[5])
  })).filter(x=>Number.isFinite(x.t) && Number.isFinite(x.c));
}

function tfToBinanceInterval(tf){
  if(tf==="15") return "15m";
  if(tf==="30") return "30m";
  if(tf==="60") return "1h";
  if(tf==="240") return "4h";
  if(tf==="D") return "1d";
  if(tf==="W") return "1w";
  return "1h";
}

async function fetchCandlesVisionFapi(symbol, tfRaw, limit){
  const interval = tfToBinanceInterval(String(tfRaw));
  const url = `https://data-api.binance.vision/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(String(limit||500))}`;
  const key = `eng:kl:${symbol}:${tfRaw}:${limit}`;
  const pack = await fetchAndCache(key, url, TTL.binanceKline);
  if((pack.status||0) >= 400) throw new Error("KLINES_"+pack.status);
  const raw = JSON.parse(pack.body.toString("utf-8"));
  return parseKlines(raw);
}

// 간단 동시성 제한
async function mapLimit(list, limit, fn){
  const out = [];
  let i = 0;
  const workers = new Array(Math.max(1,limit)).fill(0).map(async ()=>{
    while(i < list.length){
      const idx = i++;
      out[idx] = await fn(list[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ==========================================================
// ✅ Engine routes
// ==========================================================
app.post("/api/scan", async (req,res)=>{
  try{
    if(!ALGO) return res.status(500).json({ error:"ALGO_NOT_READY" });

    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    if(!symbols.length) return res.status(400).json({ error:"MISSING_SYMBOLS" });

    const tfSet = ALGO.getMTFSet6();

    // 각 심볼별 스캔
    const fullList = await mapLimit(symbols, 2, async (sym)=>{
      const s = String(sym||"").toUpperCase();
      const candlesByTf = {};
      // tf별 캔들 확보(서버는 병렬로 조금만)
      await mapLimit(tfSet, 2, async (tfRaw)=>{
        candlesByTf[tfRaw] = await fetchCandlesVisionFapi(s, tfRaw, 380);
      });

      const out = {};
      for(const baseTfRaw of tfSet){
        const baseCandles = candlesByTf[baseTfRaw] || [];
        if(baseCandles.length < (ALGO.SIM_WINDOW + ALGO.FUTURE_H + 80)){
          out[baseTfRaw] = null;
          continue;
        }
        try{
          out[baseTfRaw] = ALGO.buildSignalFromCandles_MTF(s, baseTfRaw, candlesByTf, "6TF");
        }catch(e){
          out[baseTfRaw] = null;
        }
      }

      // BEST 선택(클라이언트 로직 그대로)
      let best = null;
      for(const tfRaw of tfSet){
        const pos = out[tfRaw];
        if(!pos) continue;

        const riskHold = ALGO.isPatternBlockedHold(pos);
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

        if(pos.type === "HOLD" && !riskHold) continue;

        item._score = ALGO.computeScanScore(item);
        if(!best || item._score > best._score) best = item;
      }

      if(best){
        return {
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
        };
      }
      return {
        symbol: s,
        bestTf: "-",
        bestTfRaw: "-",
        bestType: "HOLD",
        winProb: 0.5,
        edge: 0,
        mtfAgree: 0,
        mtfVotes: "",
        confTier: "-",
        isRisk: false
      };
    });

    // 추천 TOP: bestType!=HOLD 또는 isRisk==true만 모아 점수로 정렬
    const top = fullList
      .filter(x => x && (x.bestType !== "HOLD" || x.isRisk))
      .map(x => ({
        symbol: x.symbol,
        tf: x.bestTf,
        tfRaw: x.bestTfRaw,
        type: x.bestType,
        winProb: x.winProb,
        edge: x.edge,
        mtfAgree: x.mtfAgree,
        mtfVotes: x.mtfVotes,
        confTier: x.confTier,
        isRisk: x.isRisk,
        multi: true
      }))
      .sort((a,b)=>{
        const sa = ALGO.computeScanScore(Object.assign({_score:0}, a));
        const sb = ALGO.computeScanScore(Object.assign({_score:0}, b));
        return sb - sa;
      })
      .slice(0, 12);

    res.json({ top, fullList });
  }catch(e){
    console.error("SCAN_ERR", e);
    res.status(500).json({ error:"SCAN_ERR", message: String(e?.message||e) });
  }
});

app.post("/api/predict", async (req,res)=>{
  try{
    if(!ALGO) return res.status(500).json({ error:"ALGO_NOT_READY" });

    const symbol = String(req.body?.symbol || "").toUpperCase();
    if(!symbol) return res.status(400).json({ error:"MISSING_SYMBOL" });

    const tfSet = ALGO.getMTFSet6();
    const candlesByTf = {};
    await mapLimit(tfSet, 2, async (tfRaw)=>{
      candlesByTf[tfRaw] = await fetchCandlesVisionFapi(symbol, tfRaw, ALGO.EXTENDED_LIMIT);
    });

    const out = {};
    for(const baseTfRaw of tfSet){
      const baseCandles = candlesByTf[baseTfRaw] || [];
      if(baseCandles.length < (ALGO.SIM_WINDOW + ALGO.FUTURE_H + 80)){
        out[baseTfRaw] = null;
        continue;
      }
      try{
        out[baseTfRaw] = ALGO.buildSignalFromCandles_MTF(symbol, baseTfRaw, candlesByTf, "6TF");
      }catch(e){
        out[baseTfRaw] = null;
      }
    }

    res.json({ out });
  }catch(e){
    console.error("PRED_ERR", e);
    res.status(500).json({ error:"PRED_ERR", message: String(e?.message||e) });
  }
});

app.post("/api/backtest", async (req,res)=>{
  try{
    if(!ALGO) return res.status(500).json({ error:"ALGO_NOT_READY" });

    const symbol = String(req.body?.symbol || "").toUpperCase();
    if(!symbol) return res.status(400).json({ error:"MISSING_SYMBOL" });

    // 클라이언트와 동일: 2TF 세트 (base + other)
    const baseTf = "60"; // 기본은 60 (클라 state.tf가 서버엔 없으니 안전값)
    const tfSet = ALGO.getMTFSet2(baseTf);
    const tfA = tfSet[0];
    const tfB = tfSet[1];

    const candlesA = await fetchCandlesVisionFapi(symbol, tfA, ALGO.EXTENDED_LIMIT);
    if(candlesA.length < (ALGO.SIM_WINDOW + ALGO.FUTURE_H + 120)){
      return res.json({ total:0, wins:0, winRate:0, avgPnl:0, rangeText:"캔들 부족" });
    }
    const candlesB = await fetchCandlesVisionFapi(symbol, tfB, ALGO.EXTENDED_LIMIT);

    let total=0, wins=0, pnlSum=0;
    const start = Math.max(ALGO.SIM_WINDOW + 20, 120);
    const end = candlesA.length - (ALGO.FUTURE_H + 10);

    for(let idx=start; idx<end; idx+=ALGO.SIM_STEP || 2){
      // slice for MTF
      const sliceA = candlesA.slice(0, idx+1);
      const byTf = {};
      byTf[tfA] = sliceA;

      // align other tf by time
      const tRef = sliceA[sliceA.length-1]?.t;
      if(Number.isFinite(tRef) && candlesB.length){
        const sliceB = candlesB.filter(x=>x.t <= tRef);
        if(sliceB.length >= (ALGO.SIM_WINDOW + ALGO.FUTURE_H + 80)){
          byTf[tfB] = sliceB;
        }
      }

      let pos = null;
      try{
        pos = ALGO.buildSignalFromCandles_MTF(symbol, tfA, byTf, "2TF");
      }catch(e){
        continue;
      }
      if(!pos || pos.type === "HOLD") continue;

      const ex = pos.explain || {};
      if((ex.winProb ?? 0) < ALGO.BT_MIN_PROB) continue;
      if((ex.edge ?? 0) < ALGO.BT_MIN_EDGE) continue;
      if((ex.simAvg ?? 0) < ALGO.BT_MIN_SIM) continue;

      // 엔트리 시프트
      const entryCandle = candlesA[idx+1];
      if(!entryCandle || !Number.isFinite(entryCandle.o)) continue;
      try{ ALGO.shiftPosEntryTo(pos, entryCandle.o); }catch(e){}

      const future = candlesA.slice(idx+1, Math.min(idx+1+140, candlesA.length));
      const outcome = ALGO.simulateOutcome(pos, future);
      if(!outcome?.resolved) continue;

      total++;
      if(outcome.win) wins++;
      pnlSum += (outcome.pnlPct || 0);

      if(total >= ALGO.BACKTEST_TRADES) break;
    }

    const winRate = total ? (wins/total)*100 : 0;
    const avgPnl = total ? (pnlSum/total) : 0;

    res.json({
      total,
      wins,
      winRate,
      avgPnl,
      rangeText: `${tfA} / ${tfB}`
    });
  }catch(e){
    console.error("BT_ERR", e);
    res.status(500).json({ error:"BT_ERR", message: String(e?.message||e) });
  }
});

app.listen(PORT, ()=> console.log(`YOPO Render Engine listening on :${PORT}`));
