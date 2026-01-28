import express from "express";

const app = express();
app.disable("x-powered-by");

// CORS
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") return res.status(200).send("ok");
  next();
});

// 간단 메모리 캐시
const cache = new Map();
function now() { return Date.now(); }
function getCache(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (v.exp <= now()) { cache.delete(key); return null; }
  return v;
}
function setCache(key, ttlSec, status, headers, body) {
  cache.set(key, { exp: now() + ttlSec * 1000, status, headers, body });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
}

// 요청 제한
let inflight = 0;
const MAX_INFLIGHT = 20;
async function guardedFetch(url, init) {
  if (inflight >= MAX_INFLIGHT) await new Promise(r => setTimeout(r, 120));
  inflight++;
  try { return await fetch(url, init); }
  finally { inflight--; }
}

async function proxyCached(res, upstreamUrl, ttlSec) {
  const key = upstreamUrl;
  const hit = getCache(key);
  if (hit) {
    res.status(hit.status);
    for (const [k, v] of Object.entries(hit.headers)) res.setHeader(k, v);
    return res.end(hit.body);
  }

  const up = await guardedFetch(upstreamUrl, {
    headers: { "user-agent": "YOPO-Render-Cache" }
  });
  const buf = Buffer.from(await up.arrayBuffer());
  const headers = {
    "content-type": up.headers.get("content-type") || "application/json",
    "cache-control": `public, max-age=${ttlSec}`
  };

  if (!up.ok) {
    res.status(up.status);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    return res.end(buf);
  }

  setCache(key, ttlSec, up.status, headers, buf);
  res.status(up.status);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(buf);
}

// TTL
const TTL = {
  bybitTickers: 2,
  bybitKline: 10,
  cgGlobal: 60,
  binanceKline: 10
};

// health
app.get("/", (req, res) => res.send("YOPO API Cache OK"));

// Bybit
app.get("/api/bybit/tickers", (req, res) =>
  proxyCached(res,
    "https://api.bybit.com/v5/market/tickers?category=linear",
    TTL.bybitTickers)
);

app.get("/api/bybit/kline", (req, res) => {
  const s = String(req.query.symbol || "").toUpperCase();
  if (!s) return res.status(400).send("Missing symbol");
  const i = req.query.interval || "60";
  const l = req.query.limit || "500";
  const u =
    `https://api.bybit.com/v5/market/kline?category=linear&symbol=${s}&interval=${i}&limit=${l}`;
  proxyCached(res, u, TTL.bybitKline);
});

// CoinGecko
app.get("/api/cg/global", (req, res) =>
  proxyCached(res, "https://api.coingecko.com/api/v3/global", 60)
);

// Binance Vision
app.get("/api/binance/fapi/klines", (req, res) =>
  proxyCached(res,
    "https://data-api.binance.vision/fapi/v1/klines" + (req.url.split("?")[1] ? "?" + req.url.split("?")[1] : ""),
    TTL.binanceKline)
);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
