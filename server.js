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

let __algoCache = null;
let __algoCacheAt = 0;

async function loadAlgoCore(){
  const now = Date.now();
  if(__algoCache && (now - __algoCacheAt) < 10_000) return __algoCache;

  try{
    const core = await import("./algo_core.js");
    const buildSignalFromCandles_MTF = core?.buildSignalFromCandles_MTF;
    const getMTFSet6 = core?.getMTFSet6;

    if(typeof buildSignalFromCandles_MTF !== "function"){
      __algoCache = null;
      __algoCacheAt = now;
      return null;
    }

    __algoCache = { buildSignalFromCandles_MTF, getMTFSet6 };
    __algoCacheAt = now;
    return __algoCache;
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


app.listen(PORT, ()=>{
  console.log("Listening on", PORT);
});
