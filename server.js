/**
 * YOPO API Cache (Render) — server.js
 * 역할: 브라우저 과부하/지연 방지용 "캐시/스로틀/중계" 서버
 *
 * ✅ 원칙(중요)
 * 1) 브라우저는 서버를 먼저 호출한다. (속도/안정)
 * 2) 서버가 죽거나 잠들면 브라우저는 직접 호출로 자동 폴백한다. (안전)
 * 3) (거래소 제거)은 Render(US)에서 403(CloudFront 국가/지역 차단) 가능 → 브라우저 직호출이 기본
 *
 * ✅ 제공 라우트
 * - GET /                       : 헬스체크
 * - GET /api/cg/global          : CoinGecko global (캐시)
 * - GET /api/cg/markets         : CoinGecko markets (쿼리 그대로 전달, 캐시)
 * - GET /api/binance/fapi/klines: Binance Vision futures klines (쿼리 전달, 캐시)
 * - GET /api/binance/spot/klines: Binance Vision spot klines (쿼리 전달, 캐시)
 *
 * (선택) (거래소 제거) 라우트는 만들 수 있지만, Render에서 막힐 수 있어 추천하지 않음.
 */

import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

// ----- TTL (초)
const TTL = {
  cgGlobal: 60,
  cgMarkets: 60,
  binanceKline: 10,
  futTickers: 2,
  bulkKlines: 10,
};

// ----- 간단 메모리 캐시 (Render Free에서도 동작)
const mem = new Map(); // key -> { exp:number, status:number, headers:object, body:Buffer }

function nowMs(){ return Date.now(); }
function okCors(res){
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
}

app.use((req,res,next)=>{
  okCors(res);
  if(req.method === "OPTIONS") return res.status(200).send("ok");
  next();
});

app.get("/", (req,res)=>{
  res.type("text/plain").send("YOPO API Cache OK");

app.get("/ping", (req,res) => {
  okCors(res);
  res.status(200).type("text/plain").send("pong");
});
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

// ---- Binance Vision: futures 24h tickers (TOP20 구성용)
app.get("/api/binance/fapi/ticker24hr", async (req,res) => {
  await handleCacheProxy(req,res, "https://data-api.binance.vision/fapi/v1/ticker/24hr", TTL.futTickers);
});


// ---- Binance Vision: futures klines (bulk)  symbols=BTCUSDT,ETHUSDT...
app.get("/api/binance/fapi/klines/bulk", async (req,res) => {
  okCors(res);
  const symbols = String(req.query.symbols||"");
  const interval = String(req.query.interval||"1h");
  const limit = String(req.query.limit||"500");
  const list = symbols.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,20);
  if(list.length===0) return res.status(400).json({ error:"missing symbols" });

  const out = {};
  for(const sym of list){
    const url = `https://data-api.binance.vision/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
    const key = `bulk:${sym}:${interval}:${limit}`;
    const hit = getMem(key);
    if(hit){
      try{ out[sym] = JSON.parse(hit.body.toString("utf-8")); }catch(e){ out[sym] = []; }
      continue;
    }
    const r = await fetch(url, { headers: { "user-agent":"YOPO-Render-Cache" } });
    const txt = await r.text();
    if(!r.ok){
      out[sym] = { error:`upstream ${r.status}`, body: txt.slice(0,200) };
      continue;
    }
    putMem(key, { status:200, headers:{ "content-type":"application/json; charset=utf-8" }, body: Buffer.from(txt, "utf-8") }, TTL.bulkKlines);
    try{ out[sym] = JSON.parse(txt); }catch(e){ out[sym] = []; }
  }
  res.setHeader("content-type","application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(out));
});

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

app.listen(PORT, ()=>{
  console.log("Listening on", PORT);
});
