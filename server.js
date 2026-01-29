/**
 * YOPO API Cache (Render) — server.js
 * 역할: 브라우저 과부하/지연 방지용 "캐시/스로틀/중계" 서버
 *
 * ✅ 원칙(중요)
 * 1) 브라우저는 서버를 먼저 호출한다. (속도/안정)
 * 2) 서버가 죽거나 잠들면 브라우저는 직접 호출로 자동 폴백한다. (안전)
 * 3) Bybit은 Render(US)에서 403(CloudFront 국가/지역 차단) 가능 → 브라우저 직호출이 기본
 *
 * ✅ 제공 라우트
 * - GET /                       : 헬스체크
 * - GET /api/cg/global          : CoinGecko global (캐시)
 * - GET /api/cg/markets         : CoinGecko markets (쿼리 그대로 전달, 캐시)
 * - GET /api/binance/fapi/klines: Binance Vision futures klines (쿼리 전달, 캐시)
 * - GET /api/binance/spot/klines: Binance Vision spot klines (쿼리 전달, 캐시)
 *
 * (선택) Bybit 라우트는 만들 수 있지만, Render에서 막힐 수 있어 추천하지 않음.
 */

import express from "express";
import fs from "fs/promises";
import vm from "vm";
import { fileURLToPath } from "url";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));
const PORT = process.env.PORT || 10000;

// ----- TTL (초)
const TTL = {
  cgGlobal: 60,
  cgMarkets: 60,
  binanceKline: 10,
};

// ----- 간단 메모리 캐시 (Render Free에서도 동작)
const mem = new Map(); // key -> { exp:number, status:number, headers:object, body:Buffer }

function nowMs(){ return Date.now(); }
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

app.get("/", (req,res)=>{
  res.type("text/plain").send("YOPO API Cache OK");
});

app.get("/ping", (req,res)=>{
  res.json({ ok:true, ts: Date.now() });
});

async function fetchAndCache(key, upstreamUrl, ttlSec){
  const hit = mem.get(key);
  if(hit && hit.exp > nowMs()){
    return hit;
  }

  const r = await fetch(upstreamUrl, {
    method: "GET",
    headers: {
      "user-agent": "YOPO-Render-Cache",
      "accept": "*/*",
    },
  });

  const buf = Buffer.from(await r.arrayBuffer());
  const headers = {};
  r.headers.forEach((v,k)=>{ headers[k.toLowerCase()] = v; });

  const out = { exp: nowMs() + ttlSec*1000, status: r.status, headers, body: buf };
  // 성공만 캐시 (실패는 캐시 안 함)
  if(r.ok) mem.set(key, out);
  return out;
}

function sendCached(res, c){
  // content-type 유지 (없으면 json 추정 X, 그대로)
  if(c.headers?.["content-type"]) res.setHeader("content-type", c.headers["content-type"]);
  res.setHeader("cache-control", "public, max-age=0");
  okCors(res);
  res.status(c.status).send(c.body);
}

/** CoinGecko: global */
app.get("/api/cg/global", async (req,res)=>{
  try{
    const upstream = "https://api.coingecko.com/api/v3/global";
    const key = "cg:global";
    const c = await fetchAndCache(key, upstream, TTL.cgGlobal);
    return sendCached(res, c);
  }catch(e){
    return res.status(500).type("text/plain").send("server error: "+(e?.message||String(e)));
  }
});

/** CoinGecko: markets (쿼리 그대로 전달) */
app.get("/api/cg/markets", async (req,res)=>{
  try{
    const qs = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
    const upstream = "https://api.coingecko.com/api/v3/coins/markets" + (qs ? ("?"+qs) : "");
    const key = "cg:markets:" + (qs || "default");
    const c = await fetchAndCache(key, upstream, TTL.cgMarkets);
    return sendCached(res, c);
  }catch(e){
    return res.status(500).type("text/plain").send("server error: "+(e?.message||String(e)));
  }
});

/** Binance Vision: futures klines */
app.get("/api/binance/fapi/klines", async (req,res)=>{
  try{
    const qs = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
    const upstream = "https://data-api.binance.vision/fapi/v1/klines" + (qs ? ("?"+qs) : "");
    const key = "bn:fut:" + (qs || "default");
    const c = await fetchAndCache(key, upstream, TTL.binanceKline);
    return sendCached(res, c);
  }catch(e){
    return res.status(500).type("text/plain").send("server error: "+(e?.message||String(e)));
  }
});


/** Binance Vision: futures ticker 24hr (for TOP20 universe) */
app.get("/api/binance/fapi/ticker24hr", async (req,res)=>{
  try{
    const upstream = "https://data-api.binance.vision/fapi/v1/ticker/24hr";
    const key = "bn:fut:ticker24hr";
    const c = await fetchAndCache(key, upstream, 2);
    return sendCached(res, c);
  }catch(e){
    return res.status(500).type("text/plain").send("server error: "+(e?.message||String(e)));
  }
});

/** Binance Vision: futures exchangeInfo (symbol filters) */
app.get("/api/binance/fapi/exchangeInfo", async (req,res)=>{
  try{
    const upstream = "https://data-api.binance.vision/fapi/v1/exchangeInfo";
    const key = "bn:fut:exchangeInfo";
    const c = await fetchAndCache(key, upstream, 60);
    return sendCached(res, c);
  }catch(e){
    return res.status(500).type("text/plain").send("server error: "+(e?.message||String(e)));
  }
});

/** Binance Vision: futures klines BULK
 * body: { symbols:[...], interval:"1h", limit:500 }
 */
app.post("/api/binance/fapi/klines/bulk", async (req,res)=>{
  try{
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    const interval = String(req.body?.interval || "1h");
    const limit = String(req.body?.limit || "500");
    if(!symbols.length) return res.status(400).json({ ok:false, error:"Missing symbols[]" });

    const maxConc = 5;
    const out = {};
    let idx = 0;

    async function worker(){
      while(idx < symbols.length){
        const my = idx++;
        const sym = String(symbols[my]||"").toUpperCase();
        if(!sym) continue;
        const qs = `?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
        const upstream = "https://data-api.binance.vision/fapi/v1/klines" + qs;
        const key = "bn:fut:kline:" + sym + ":" + interval + ":" + limit;
        const c = await fetchAndCache(key, upstream, TTL.binanceKline);
        if(c.status >= 200 && c.status < 300){
          try{ out[sym] = JSON.parse(c.body.toString("utf-8")); }
          catch(e){ out[sym] = null; }
        }else{
          out[sym] = null;
        }
      }
    }

    const workers = [];
    for(let i=0;i<Math.min(maxConc, symbols.length);i++) workers.push(worker());
    await Promise.all(workers);

    return res.json({ ok:true, interval, limit:Number(limit), data: out });
  }catch(e){
    return res.status(500).json({ ok:false, error:"server error: "+(e?.message||String(e)) });
  }
});

/** Binance Vision: spot klines */
app.get("/api/binance/spot/klines", async (req,res)=>{
  try{
    const qs = req.originalUrl.includes("?") ? req.originalUrl.split("?")[1] : "";
    const upstream = "https://data-api.binance.vision/api/v3/klines" + (qs ? ("?"+qs) : "");
    const key = "bn:spot:" + (qs || "default");
    const c = await fetchAndCache(key, upstream, TTL.binanceKline);
    return sendCached(res, c);
  }catch(e){
    return res.status(500).type("text/plain").send("server error: "+(e?.message||String(e)));
  }
});


/* ==========================================================
   ENGINE SECTION (SERVER-SIDE)
   - /api/engine/predict6tf
   - /api/engine/scan_all
   - /api/engine/backtest (stub)
   ========================================================== */

function _tfToInterval(tfRaw){
  if(tfRaw === "15") return "15m";
  if(tfRaw === "30") return "30m";
  if(tfRaw === "60") return "1h";
  if(tfRaw === "240") return "4h";
  if(tfRaw === "D") return "1d";
  if(tfRaw === "W") return "1w";
  const n = Number(tfRaw);
  if(Number.isFinite(n) && n > 0) return `${n}m`;
  return "1h";
}

function _normSymbol(x){
  return String(x || "").toUpperCase().trim();
}

function _universeToSymbols(universe){
  if(!Array.isArray(universe)) return [];
  const out = [];
  for(const u of universe){
    const sym = _normSymbol(u?.symbol ?? u?.s ?? u);
    if(sym && !out.includes(sym)) out.push(sym);
  }
  return out;
}

function _rawKlinesToCandles(raw){
  if(!Array.isArray(raw)) return [];
  const out = raw.map(k => ({
    t: Number(k?.[0]),
    o: Number(k?.[1]),
    h: Number(k?.[2]),
    l: Number(k?.[3]),
    c: Number(k?.[4]),
    v: Number(k?.[5] ?? 0),
  })).filter(x => Number.isFinite(x.t) && Number.isFinite(x.c) && Number.isFinite(x.h) && Number.isFinite(x.l));
  out.sort((a,b)=>a.t-b.t);
  return out;
}

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

async function _fetchKlinesFut(symbol, tfRaw, limit){
  const interval = _tfToInterval(tfRaw);
  const sym = _normSymbol(symbol);
  const lim = Math.max(10, Math.min(1500, Number(limit)||500));
  const qs = `?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(String(lim))}`;
  const upstream = "https://data-api.binance.vision/fapi/v1/klines" + qs;
  const key = `bn:fut:engine:${sym}:${interval}:${lim}`;
  const c = await fetchAndCache(key, upstream, TTL.binanceKline);
  if(!(c.status >= 200 && c.status < 300)) return [];
  try{
    const raw = JSON.parse(c.body.toString("utf-8"));
    return _rawKlinesToCandles(raw);
  }catch(e){
    return [];
  }
}

async function _fetchPack6(symbol, limitBase=380){
  const [c15,c60,c240,cD] = await Promise.all([
    _fetchKlinesFut(symbol,"15",limitBase),
    _fetchKlinesFut(symbol,"60",limitBase),
    _fetchKlinesFut(symbol,"240",limitBase),
    _fetchKlinesFut(symbol,"D",limitBase),
  ]);
  const c30 = (c15 && c15.length>=2) ? _resampleCandles(c15,2) : [];
  const cW  = (cD && cD.length>=7) ? _resampleToW_fromD(cD) : [];
  return { "15":c15, "30":c30, "60":c60, "240":c240, "D":cD, "W":(cW.length?cW:cD) };
}

/* ==========================================================
   ✅ EVOLVE PERSISTENCE (Upstash Redis 확정)
   - 성공/실패 피드백을 Upstash Redis(REST)로 영구 저장
   - Upstash 장애/미설정 시: 파일(evolve_memory.json)로 안전 폴백
   ========================================================== */

// Upstash ENV (Render Environment Variables)
const UPSTASH_REDIS_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").trim();
const UPSTASH_REDIS_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const USE_UPSTASH = Boolean(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

// Fallback file (Render Free에서 로컬 파일은 '영구 보장'이 아님. Upstash가 최종 권장)
const EVOLVE_FILE = process.env.EVOLVE_FILE || "./evolve_memory.json";
const EVOLVE_MAX_EVENTS = Number(process.env.EVOLVE_MAX_EVENTS || 5000);

// Upstash key (필요 시 변경 가능)
const EVOLVE_UPSTASH_KEY = process.env.EVOLVE_UPSTASH_KEY || "yopo:evolve:memory:v1";

// runtime memory
let evolveMem = { v: 1, events: [] };
let evolveLoaded = false;
let evolveSeeded = false; // algo_core metaBrain에 replay를 1회만 수행
let evolveDirty = false;
let evolveSaveTimer = null;

function _upstashBaseUrl(){
  return UPSTASH_REDIS_REST_URL.replace(/\/+$/,"");
}

async function upstashGet(key){
  const url = `${_upstashBaseUrl()}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "accept": "application/json",
    }
  });
  if(!r.ok) throw new Error(`UPSTASH_GET_HTTP_${r.status}`);
  const j = await r.json();
  return (j && typeof j === "object") ? (j.result ?? null) : null;
}

async function upstashSet(key, valueStr){
  const url = `${_upstashBaseUrl()}/set/${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
      "content-type": "text/plain; charset=utf-8",
      "accept": "application/json",
    },
    body: String(valueStr ?? "")
  });
  if(!r.ok) throw new Error(`UPSTASH_SET_HTTP_${r.status}`);
  return await r.json().catch(()=>null);
}

async function evolveLoadFromFile(){
  try{
    const p = _absPath(EVOLVE_FILE);
    const raw = await fs.readFile(p, "utf-8");
    const obj = JSON.parse(raw);
    if(obj && typeof obj === "object" && Array.isArray(obj.events)){
      evolveMem = { v: 1, events: obj.events.slice(-EVOLVE_MAX_EVENTS) };
      return evolveMem;
    }
  }catch(e){}
  evolveMem = { v: 1, events: [] };
  return evolveMem;
}

async function evolveSaveToFile(){
  try{
    const p = _absPath(EVOLVE_FILE);
    await fs.writeFile(p, JSON.stringify(evolveMem, null, 2), "utf-8");
  }catch(e){}
}

async function evolveLoad(){
  if(evolveLoaded) return evolveMem;
  evolveLoaded = true;

  if(USE_UPSTASH){
    try{
      const raw = await upstashGet(EVOLVE_UPSTASH_KEY);
      if(raw){
        const obj = JSON.parse(String(raw));
        if(obj && typeof obj === "object" && Array.isArray(obj.events)){
          evolveMem = { v: 1, events: obj.events.slice(-EVOLVE_MAX_EVENTS) };
          return evolveMem;
        }
      }
      evolveMem = { v: 1, events: [] };
      return evolveMem;
    }catch(e){
      // Upstash 실패 → 파일 폴백
      return await evolveLoadFromFile();
    }
  }
  // Upstash 미설정 → 파일
  return await evolveLoadFromFile();
}

function evolveScheduleSave(){
  evolveDirty = true;
  if(evolveSaveTimer) return;

  evolveSaveTimer = setTimeout(async ()=>{
    evolveSaveTimer = null;
    if(!evolveDirty) return;
    evolveDirty = false;

    if(USE_UPSTASH){
      try{
        await upstashSet(EVOLVE_UPSTASH_KEY, JSON.stringify(evolveMem));
        return;
      }catch(e){
        await evolveSaveToFile();
        return;
      }
    }
    await evolveSaveToFile();
  }, 800);
}

function evolveNormalizeFeedback(body){
  const symbol = String(body?.symbol || "").toUpperCase().trim();
  const tf = String(body?.tf ?? body?.tfRaw ?? "");
  const type = String(body?.type || "").toUpperCase().trim(); // LONG/SHORT/HOLD
  const win = (body?.result === "WIN") || (body?.win === true);
  const reason = String(body?.reason || "");
  const metaKey = (typeof body?.metaKey === "string") ? body.metaKey : null;
  const ts = Number(body?.ts || body?.closedAt || Date.now());

  if(!symbol || !tf) return null;
  if(!(type === "LONG" || type === "SHORT" || type === "HOLD")) return null;

  return {
    ts,
    symbol,
    tf,
    type,
    win,
    reason,
    metaKey,
    pnlPct: Number(body?.pnlPct),
    mfePct: Number(body?.mfePct),
  };
}

let __algoCache = null;
let __algoCacheAt = 0;

function _absPath(rel){
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  return path.join(__dirname, rel);
}

async function loadAlgoCore(){
  const now = Date.now();
  if(__algoCache && (now - __algoCacheAt) < 10_000) return __algoCache;

  // 1) ESM export 방식
  try{
    const core = await import("./algo_core.js");
    const buildSignalFromCandles_MTF = core?.buildSignalFromCandles_MTF;
    const getMTFSet6 = core?.getMTFSet6;
    if(typeof buildSignalFromCandles_MTF === "function"){
      __algoCache = {
        buildSignalFromCandles_MTF,
        getMTFSet6,
        evolveApplyFeedback: core?.evolveApplyFeedback,
        evolveReplayEvents: core?.evolveReplayEvents,
      };
      __algoCacheAt = now;

      // ✅ 서버 시작 후 1회만: 저장된 이벤트를 metaBrain에 재생
      try{
        if(!evolveSeeded){
          await evolveLoad();
          if(typeof __algoCache?.evolveReplayEvents === "function"){
            __algoCache.evolveReplayEvents(evolveMem.events);
          }
          evolveSeeded = true;
        }
      }catch(e){}
      return __algoCache;
    }
  }catch(e){
    // ignore → fallback
  }

  // 2) ✅ VM 방식 (브라우저 스크립트 호환)
  try{
    const code = await fs.readFile(_absPath("./algo_core.js"), "utf-8");
    const ctx = vm.createContext({ console, Math, Date, setTimeout, clearTimeout, setInterval, clearInterval });
    vm.runInContext(code, ctx, { timeout: 1000 });

    const buildSignalFromCandles_MTF = ctx.buildSignalFromCandles_MTF;
    const getMTFSet6 = ctx.getMTFSet6;
    const evolveApplyFeedback = ctx.evolveApplyFeedback;
    const evolveReplayEvents = ctx.evolveReplayEvents;

    if(typeof buildSignalFromCandles_MTF === "function"){
      __algoCache = {
        buildSignalFromCandles_MTF,
        getMTFSet6,
        evolveApplyFeedback,
        evolveReplayEvents,
      };
      __algoCacheAt = now;

      try{
        if(!evolveSeeded){
          await evolveLoad();
          if(typeof __algoCache?.evolveReplayEvents === "function"){
            __algoCache.evolveReplayEvents(evolveMem.events);
          }
          evolveSeeded = true;
        }
      }catch(e){}
      return __algoCache;
    }
    __algoCache = null;
    __algoCacheAt = now;
    return null;
  }catch(e){
    __algoCache = null;
    __algoCacheAt = now;
    return null;
  }
}

function engineNotReady(res, detail){
  return res.status(501).json({
    ok:false,
    error:"ENGINE_NOT_READY",
    detail: detail || "algo_core.js missing or export mismatch",
    hint: "Render 서버 프로젝트 루트에 algo_core.js가 있어야 하고, buildSignalFromCandles_MTF/getMTFSet6를 export 해야 합니다."
  });
}

app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    const core = await loadAlgoCore();
    if(!core) return engineNotReady(res, "engine functions not available");

    const universe = req.body?.universe;
    const bodySymbol = _normSymbol(req.body?.symbol);
    const symbols = _universeToSymbols(universe);
    const symbol = bodySymbol || symbols?.[0];
    if(!symbol) return res.status(400).json({ ok:false, error:"Missing symbol or universe" });

    const tfs = (typeof core.getMTFSet6 === "function") ? core.getMTFSet6() : ["15","30","60","240","D","W"];
    const limitBase = Number(req.body?.limitBase ?? 380);

    const candlesByTf = await _fetchPack6(symbol, limitBase);

    const out = {};
    for(const tfRaw of tfs){
      const baseCandles = candlesByTf[tfRaw] || [];
      if(!baseCandles || baseCandles.length < 120){
        out[tfRaw] = null;
        continue;
      }
      try{
        out[tfRaw] = core.buildSignalFromCandles_MTF(symbol, tfRaw, candlesByTf, "6TF");
      }catch(e){
        out[tfRaw] = null;
      }
    }

    return res.json({ ok:true, symbol, out, meta:{ tfs, limitBase, ts: Date.now() } });
  }catch(e){
    return res.status(500).json({ ok:false, error:"server error: "+(e?.message||String(e)) });
  }
});

app.post("/api/engine/scan_all", async (req,res)=>{
  try{
    const core = await loadAlgoCore();
    if(!core) return engineNotReady(res, "engine functions not available");

    const symbols = _universeToSymbols(req.body?.universe);
    if(!symbols.length) return res.status(400).json({ ok:false, error:"Missing universe[]" });

    const tfs = (typeof core.getMTFSet6 === "function") ? core.getMTFSet6() : ["15","30","60","240","D","W"];
    const limitBase = Number(req.body?.limitBase ?? 380);
    const topK = Math.max(5, Math.min(200, Number(req.body?.topK ?? 30)));

    const resultsByTf = {};
    for(const tf of tfs) resultsByTf[tf] = [];

    const maxConc = 4;
    let idx = 0;

    async function worker(){
      while(idx < symbols.length){
        const my = idx++;
        const sym = symbols[my];
        const candlesByTf = await _fetchPack6(sym, limitBase);

        for(const tfRaw of tfs){
          const baseCandles = candlesByTf[tfRaw] || [];
          if(!baseCandles || baseCandles.length < 120) continue;

          let pos = null;
          try{
            pos = core.buildSignalFromCandles_MTF(sym, tfRaw, candlesByTf, "6TF");
          }catch(e){
            pos = null;
          }
          if(!pos) continue;

          const ex = pos.explain || {};
          const winProb = Number(ex.winProb ?? ex.winP ?? 0);
          const edge = Number(ex.edge ?? 0);

          resultsByTf[tfRaw].push({
            symbol: pos.symbol,
            tf: pos.tf,
            tfRaw: pos.tfRaw,
            type: pos.type,
            winProb,
            edge,
            score: edge,
            isHold: pos.type === "HOLD",
          });
        }
      }
    }

    const workers = [];
    for(let i=0;i<Math.min(maxConc, symbols.length);i++) workers.push(worker());
    await Promise.all(workers);

    for(const tfRaw of tfs){
      resultsByTf[tfRaw].sort((a,b)=> (b.score||0) - (a.score||0));
      resultsByTf[tfRaw] = resultsByTf[tfRaw].slice(0, topK);
    }

    return res.json({ ok:true, resultsByTf, meta:{ universeSize:symbols.length, tfs, limitBase, topK, ts: Date.now() } });
  }catch(e){
    return res.status(500).json({ ok:false, error:"server error: "+(e?.message||String(e)) });
  }
});

// backtest: 아직 알고리즘 export가 없으면 501로 안내만
app.post("/api/engine/backtest", async (req,res)=>{
  return engineNotReady(res, "backtest engine not wired yet");
});


/**
 * POST /api/engine/backtest
 * body: { universe:[...], limitBase?:900, tradesPerTf?:80 }
 * return: { ok:true, rows:[...], meta:{...} }
 */
app.post("/api/engine/backtest", async (req,res)=>{
  try{
    const algo = await loadAlgoCore();
    if(!algo) return engineNotReady(res, "algo_core load failed (need buildSignalFromCandles_MTF)");

    const { buildSignalFromCandles_MTF, getMTFSet6 } = algo;

    const symbols = _universeToSymbols(req.body?.universe);
    if(!symbols.length) return res.status(400).json({ ok:false, error:"Missing universe[]" });

    const tfs = (typeof getMTFSet6 === "function") ? getMTFSet6() : ["15","30","60","240","D","W"];
    const limitBase = Math.max(220, Math.min(1200, Number(req.body?.limitBase ?? 900)));
    const tradesPerTf = Math.max(10, Math.min(120, Number(req.body?.tradesPerTf ?? 80)));

    const horizonByTf = { "15": 64, "30": 48, "60": 36, "240": 24, "D": 14, "W": 10 };
    const stepByTf    = { "15": 8,  "30": 6,  "60": 4,  "240": 2,  "D": 1,  "W": 1  };

    function _outcome(pos, futureCandles){
      if(!pos || pos.type === "HOLD" || !Number.isFinite(pos.tp) || !Number.isFinite(pos.sl)) return null;
      const isLong = (pos.type === "LONG") || (pos.tp > pos.entry);
      for(const c of futureCandles){
        const hi = c.h, lo = c.l;
        if(isLong){
          if(hi >= pos.tp) return { win:true };
          if(lo <= pos.sl) return { win:false };
        }else{
          if(lo <= pos.tp) return { win:true };
          if(hi >= pos.sl) return { win:false };
        }
      }
      return null;
    }

    function _cutIndex(arr, cutT){
      let lo=0, hi=arr.length-1, ans=-1;
      while(lo<=hi){
        const mid=(lo+hi)>>1;
        if(arr[mid].t <= cutT){ ans=mid; lo=mid+1; }
        else hi=mid-1;
      }
      return ans;
    }

    const rows = [];
    const maxConc = 2;
    let idx = 0;

    async function worker(){
      while(idx < symbols.length){
        const my = idx++;
        const symbol = symbols[my];

        const candlesByTfFull = await _fetchPack6(symbol, limitBase);

        for(const tfRaw of tfs){
          const series = candlesByTfFull[tfRaw] || [];
          if(series.length < 220) continue;

          const horizon = horizonByTf[tfRaw] ?? 36;
          const step = stepByTf[tfRaw] ?? 4;

          let wins=0, losses=0, skipped=0, samples=0, sumRet=0;

          for(let i = series.length - horizon - 2; i >= 220 && samples < tradesPerTf; i -= step){
            const cutT = series[i].t;

            const pack = {};
            for(const tf2 of tfs){
              const arr = candlesByTfFull[tf2] || [];
              const ci = _cutIndex(arr, cutT);
              pack[tf2] = (ci >= 0) ? arr.slice(0, ci+1) : [];
            }

            if((pack[tfRaw]?.length || 0) < 120) continue;

            let pos = null;
            try{
              pos = buildSignalFromCandles_MTF(symbol, tfRaw, pack, "6TF");
            }catch(e){
              skipped++; continue;
            }
            if(!pos || pos.type === "HOLD"){ skipped++; continue; }

            const future = series.slice(i+1, i+1+horizon);
            const oc = _outcome(pos, future);
            if(!oc){ skipped++; continue; }

            const tpPct = Number(pos.tpPct || 0);
            const slPct = Number(pos.slPct || 0);

            if(oc.win){
              wins++; samples++;
              if(Number.isFinite(tpPct) && tpPct>0) sumRet += tpPct;
            }else{
              losses++; samples++;
              if(Number.isFinite(slPct) && slPct>0) sumRet -= slPct;
            }
          }

          if(samples <= 0) continue;

          rows.push({
            symbol,
            strategy: tfRaw,
            samples,
            winRate: wins / samples,
            avgRet: sumRet / samples,
            note: `skip:${skipped}`
          });
        }
      }
    }

    const workers = [];
    for(let i=0;i<Math.min(maxConc, symbols.length);i++) workers.push(worker());
    await Promise.all(workers);

    rows.sort((a,b)=> (b.samples - a.samples) || (b.winRate - a.winRate));

    return res.json({
      ok:true,
      rows,
      meta:{ universeSize: symbols.length, tfs, limitBase, tradesPerTf, ts: Date.now() }
    });
  }catch(e){
    return res.status(500).json({ ok:false, error:"server error: "+(e?.message||String(e)) });
  }
});

/* ==========================================================
   EVOLVE ROUTES
   - POST /api/evolve/feedback : 성공/실패 피드백 누적(Upstash 영구)
   - GET  /api/evolve/stats    : 통계 조회(디버그)
   ========================================================== */

app.post("/api/evolve/feedback", async (req,res)=>{
  try{
    await evolveLoad();
    const fb = evolveNormalizeFeedback(req.body);
    if(!fb) return res.status(400).json({ ok:false, error:"BAD_FEEDBACK" });

    evolveMem.events.push(fb);
    if(evolveMem.events.length > EVOLVE_MAX_EVENTS){
      evolveMem.events = evolveMem.events.slice(-EVOLVE_MAX_EVENTS);
    }
    evolveScheduleSave();

    // 런타임 즉시 반영 (metaBrain)
    try{
      const core = await loadAlgoCore();
      if(core && typeof core.evolveApplyFeedback === "function"){
        core.evolveApplyFeedback(fb);
      }
    }catch(e){}

    return res.json({ ok:true, persisted: USE_UPSTASH ? "UPSTASH" : "FILE_FALLBACK" });
  }catch(e){
    return res.status(500).json({ ok:false, error:"SERVER_ERROR", detail: e?.message || String(e) });
  }
});

app.get("/api/evolve/stats", async (req,res)=>{
  try{
    await evolveLoad();
    const stats = {};
    for(const ev of evolveMem.events){
      const key = ev.metaKey || `${ev.symbol}|${ev.tf}|${ev.type}`;
      const s = stats[key] || { n:0, w:0, lastTs:0, symbol:ev.symbol, tf:ev.tf, type:ev.type };
      s.n += 1;
      if(ev.win) s.w += 1;
      if(ev.ts > s.lastTs) s.lastTs = ev.ts;
      stats[key] = s;
    }
    const arr = Object.entries(stats).map(([k,v])=>({ key:k, ...v, wr: v.n ? (v.w/v.n) : 0 }));
    arr.sort((a,b)=> (b.wr - a.wr) || (b.n - a.n) || (b.lastTs - a.lastTs));
    return res.json({ ok:true, totalEvents: evolveMem.events.length, items: arr.slice(0, 200), persisted: USE_UPSTASH ? "UPSTASH" : "FILE_FALLBACK" });
  }catch(e){
    return res.status(500).json({ ok:false, error:"SERVER_ERROR", detail: e?.message || String(e) });
  }
});

app.listen(PORT, ()=>{
  console.log("Listening on", PORT);
  console.log("EVOLVE_PERSIST:", USE_UPSTASH ? "UPSTASH" : "FILE_FALLBACK");
});
