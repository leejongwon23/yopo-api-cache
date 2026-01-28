import express from "express";

/**
 * YOPO API Cache Server (Render)
 * 목적: 브라우저가 거래소/코인게코를 직접 많이 호출해서 먹통이 되는 문제를 해결
 * 방식: 서버가 데이터 수집 + 캐시 + 요청폭주 방지 → 브라우저는 서버만 호출
 *
 * ✅ 지원 라우트 (브라우저는 이 주소만 호출)
 * - GET /                         : health
 * - GET /api/bybit/tickers
 * - GET /api/bybit/kline?symbol=BTCUSDT&interval=60&limit=500
 * - GET /api/cg/global
 * - GET /api/cg/markets?...       : 쿼리 그대로 전달
 * - GET /api/binance/fapi/klines?...            (기본: data-api.binance.vision)
 * - GET /api/binance/spot/klines?...
 * - GET /api/binance/fapi/klines_fallback?...   (공식 도메인, 막힐 수 있음)
 * - GET /api/binance/spot/klines_fallback?...
 */

const app = express();
app.disable("x-powered-by");

// --- CORS (GitHub Pages/브라우저에서 바로 호출 가능)
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  next();
});

// --- 간단 메모리 캐시 + TTL
const cache = new Map(); // key -> { exp, status, headers, body(Buffer) }
const now = () => Date.now();

function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (v.exp <= now()) { cache.delete(key); return null; }
  return v;
}
function cacheSet(key, ttlSec, status, headers, body) {
  cache.set(key, { exp: now() + ttlSec * 1000, status, headers, body });
  // 캐시 과도 증가 방지
  if (cache.size > 1200) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// --- 요청 폭주 방지(동시요청 제한)
let inflight = 0;
const MAX_INFLIGHT = 30;

async function guardedFetch(url) {
  if (inflight >= MAX_INFLIGHT) {
    await new Promise(r => setTimeout(r, 120));
  }
  inflight++;
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": "YOPO-Render-Cache",
        "accept": "application/json,text/plain,*/*"
      }
    });
  } finally {
    inflight--;
  }
}

function pickContentType(res) {
  return res.headers.get("content-type") || "application/json; charset=utf-8";
}

async function proxyCached(res, upstreamUrl, ttlSec) {
  const key = upstreamUrl;
  const hit = cacheGet(key);
  if (hit) {
    res.status(hit.status);
    for (const [k, v] of Object.entries(hit.headers)) res.setHeader(k, v);
    return res.end(hit.body);
  }

  const up = await guardedFetch(upstreamUrl);
  const buf = Buffer.from(await up.arrayBuffer());

  const headers = {
    "content-type": pickContentType(up),
    "cache-control": `public, max-age=${ttlSec}`
  };

  if (!up.ok) {
    res.status(up.status);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end(buf);
  }

  cacheSet(key, ttlSec, up.status, headers, buf);

  res.status(up.status);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  return res.end(buf);
}

const TTL = {
  bybitTickers: 2,
  bybitKline: 10,
  cgGlobal: 60,
  cgMarkets: 60,
  binanceKline: 10
};

app.get("/", (req, res) => res.status(200).send("YOPO API Cache OK"));

// --- Bybit
app.get("/api/bybit/tickers", (req, res) => {
  const upstream = "https://api.bybit.com/v5/market/tickers?category=linear";
  return proxyCached(res, upstream, TTL.bybitTickers);
});

app.get("/api/bybit/kline", (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const interval = String(req.query.interval || "60");
  const limit = String(req.query.limit || "500");
  if (!symbol) return res.status(400).send("Missing symbol");

  const upstream =
    "https://api.bybit.com/v5/market/kline?category=linear" +
    `&symbol=${encodeURIComponent(symbol)}` +
    `&interval=${encodeURIComponent(interval)}` +
    `&limit=${encodeURIComponent(limit)}`;

  return proxyCached(res, upstream, TTL.bybitKline);
});

// --- CoinGecko
app.get("/api/cg/global", (req, res) => {
  const upstream = "https://api.coingecko.com/api/v3/global";
  return proxyCached(res, upstream, TTL.cgGlobal);
});

app.get("/api/cg/markets", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const upstream = `https://api.coingecko.com/api/v3/coins/markets${qs}`;
  return proxyCached(res, upstream, TTL.cgMarkets);
});

// --- Binance (Vision 미러)
app.get("/api/binance/fapi/klines", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const upstream = `https://data-api.binance.vision/fapi/v1/klines${qs}`;
  return proxyCached(res, upstream, TTL.binanceKline);
});

app.get("/api/binance/spot/klines", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const upstream = `https://data-api.binance.vision/api/v3/klines${qs}`;
  return proxyCached(res, upstream, TTL.binanceKline);
});

// --- Binance 공식(막힐 수 있음)
app.get("/api/binance/fapi/klines_fallback", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const upstream = `https://fapi.binance.com/fapi/v1/klines${qs}`;
  return proxyCached(res, upstream, TTL.binanceKline);
});

app.get("/api/binance/spot/klines_fallback", (req, res) => {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const upstream = `https://api.binance.com/api/v3/klines${qs}`;
  return proxyCached(res, upstream, TTL.binanceKline);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
