/*************************************************************
 * YOPO AI PRO — server.js (FULL · BINANCE20 · EVOLVE/UPSTASH)
 * FIX(2026-02-03):
 * - Binance API returns 451 (restricted location) from Render egress.
 * - Add DATA_PROXY_BASE (or DATA_PROXY_BASES) to route Binance requests via an allowed proxy.
 *   Example: DATA_PROXY_BASE="https://YOUR-PROXY.DOMAIN/proxy?url="
 *   or:      DATA_PROXY_BASES="https://p1/proxy?url=,https://p2/proxy?url="
 * - Add /api/diag/binance to confirm connectivity (direct vs proxy).
 *************************************************************/
import express from "express";
import cors from "cors";
import { predict, detectRegime } from "./algo_core.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// 20-coin universe (Binance Futures USDT)
const UNIVERSE20 = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT",
  "MATICUSDT","LTCUSDT","BCHUSDT","TRXUSDT","ATOMUSDT",
  "OPUSDT","ARBUSDT","INJUSDT","APTUSDT","SUIUSDT"
];

// 6TF fixed set for YOPO AI PRO (spec): 15m / 30m / 1h / 4h / 1d / 1w
const TF_MAP = {
  "15m":"15m",
  "30m":"30m",
  "1h":"1h",
  "4h":"4h",
  "1d":"1d",
  "1w":"1w",
};

// Binance endpoints can sometimes block certain IP ranges.
const BINANCE_FUTURES_BASES = [
  "https://fapi.binance.com",
  "https://fapi.binance.vision",
];

// ✅ If Binance blocks Render (451), use a proxy in an allowed region.
// Support one or many proxies. Each proxy is a PREFIX that receives the encoded upstream URL.
// Examples:
//  - DATA_PROXY_BASE="https://your-proxy.com/proxy?url="
//  - DATA_PROXY_BASES="https://p1/proxy?url=,https://p2/proxy?url="
const DATA_PROXY_BASE = (process.env.DATA_PROXY_BASE || "").trim();
const DATA_PROXY_BASES = (process.env.DATA_PROXY_BASES || "")
  .split(",").map(s=>s.trim()).filter(Boolean);

const PROXIES = [
  ...(DATA_PROXY_BASE ? [DATA_PROXY_BASE] : []),
  ...DATA_PROXY_BASES
];

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchWithTimeout(url, opts={}, timeoutMs=12_000){
  const ac = new AbortController();
  const t = setTimeout(()=>ac.abort(new Error("FETCH_TIMEOUT")), timeoutMs);
  try{
    const res = await fetch(url, { ...opts, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// in-memory cache (simple)
const cache = new Map(); // key -> {ts, data}
function cacheGet(key, ttlMs){
  const x = cache.get(key);
  if(!x) return null;
  if(Date.now()-x.ts > ttlMs) return null;
  return x.data;
}
function cacheSet(key, data){
  cache.set(key, { ts: Date.now(), data });
}

async function fetchKlines(symbol, interval="15m", limit=300){
  const candles = await fetchKlinesSafe(symbol, interval, limit);
  if(!candles) throw new Error("BINANCE_FETCH_FAILED");
  return candles;
}

function _parseKlinesArray(arr){
  if(!Array.isArray(arr)) return null;
  return arr.map(k=>({
    ts: k[0],
    open: +k[1],
    high: +k[2],
    low:  +k[3],
    close:+k[4],
    volume:+k[5]
  }));
}

function atrPctFromCandles(candles, period=14){
  const n = candles.length;
  if(n < period+1) return 0.01;
  let sum = 0;
  for(let i=n-period;i<n;i++){
    const c = candles[i];
    const p = candles[i-1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    sum += tr;
  }
  const atr = sum/period;
  const last = candles[n-1].close || 1;
  const pct = atr/last;
  return Number.isFinite(pct) && pct>0 ? pct : 0.01;
}

// ===== Proxy-aware fetch helpers =====
function _wrapProxy(proxyBase, upstreamUrl){
  // proxyBase is a PREFIX (recommended) that already ends with "?url=" or similar.
  // If user provides just a base URL without query, we still try to append.
  if(!proxyBase) return upstreamUrl;
  if(proxyBase.includes("?url=") || proxyBase.endsWith("=")) return proxyBase + encodeURIComponent(upstreamUrl);
  // fallback: add ?url=
  const join = proxyBase.includes("?") ? "&url=" : "?url=";
  return proxyBase + join + encodeURIComponent(upstreamUrl);
}

async function _fetchJsonSmart(upstreamUrl, { headers={}, timeoutMs=12_000, cacheKey=null, cacheTtlMs=0 } = {}){
  // 1) cache
  if(cacheKey && cacheTtlMs>0){
    const cached = cacheGet(cacheKey, cacheTtlMs);
    if(cached) return { ok:true, json:cached, via:"cache" };
  }

  // 2) try DIRECT first (maybe works sometimes)
  let lastErr = null;
  try{
    const res = await fetchWithTimeout(upstreamUrl, { headers }, timeoutMs);
    if(res.ok){
      const j = await res.json();
      if(cacheKey && cacheTtlMs>0) cacheSet(cacheKey, j);
      return { ok:true, json:j, via:"direct" };
    }else{
      const body = await res.text().catch(()=> "");
      lastErr = { status:res.status, body: String(body||"").slice(0, 240), via:"direct" };
    }
  }catch(e){
    lastErr = { status:0, body:String(e?.message||e), via:"direct" };
  }

  // 3) if blocked / failed, try PROXIES (if any)
  for(const p of PROXIES){
    const proxiedUrl = _wrapProxy(p, upstreamUrl);
    try{
      const res = await fetchWithTimeout(proxiedUrl, { headers }, timeoutMs);
      if(res.ok){
        const j = await res.json();
        if(cacheKey && cacheTtlMs>0) cacheSet(cacheKey, j);
        return { ok:true, json:j, via:"proxy" };
      }else{
        const body = await res.text().catch(()=> "");
        lastErr = { status:res.status, body:String(body||"").slice(0, 240), via:"proxy" };
        continue;
      }
    }catch(e){
      lastErr = { status:0, body:String(e?.message||e), via:"proxy" };
      continue;
    }
  }

  return { ok:false, err:lastErr || { status:0, body:"UNKNOWN", via:"none" } };
}

/**
 * Safe klines fetch
 * - Tries futures endpoints.
 * - If Binance blocks (451), tries DATA_PROXY_BASE(S) automatically.
 * - Returns null on failure (never hard-crash engine endpoints).
 */
async function fetchKlinesSafe(symbol, interval="15m", limit=300){
  const keyCandles = `klines:${symbol}:${interval}:${limit}`;
  const cached = cacheGet(keyCandles, 20_000);
  if(cached) return cached;

  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };

  let lastErr = null;

  for(const base of BINANCE_FUTURES_BASES){
    const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;

    const r = await _fetchJsonSmart(url, { headers, timeoutMs:12_000 });
    if(!r.ok){
      lastErr = r.err;
      // mild backoff for rate limits
      if(r.err?.status===429 || r.err?.status===418) await sleep(350);
      continue;
    }

    const candles = _parseKlinesArray(r.json);
    if(!candles || candles.length===0){
      lastErr = { status:0, body:"EMPTY", via:r.via };
      continue;
    }

    cacheSet(keyCandles, candles);
    return candles;
  }

  console.error("[YOPO][fetchKlinesSafe] fail", symbol, interval, limit, lastErr?.status || "", lastErr?.via || "", lastErr?.body || "");
  return null;
}


// ===== Upstash helpers (optional) =====
const UP_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const EVOLVE_KEY = process.env.EVOLVE_UPSTASH_KEY || "yopo:evolve:events";
const EVOLVE_MAX = Number(process.env.EVOLVE_MAX_EVENTS || 5000);

async function upstashCommand(cmd, args=[]){
  if(!UP_URL || !UP_TOKEN) return null;
  const url = `${UP_URL}/${cmd}/${args.map(a=>encodeURIComponent(a)).join("/")}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${UP_TOKEN}` } });
  if(!res.ok) throw new Error("UPSTASH_"+res.status);
  return await res.json();
}

async function evolveAppend(eventObj){
  if(UP_URL && UP_TOKEN){
    const payload = JSON.stringify(eventObj);
    await upstashCommand("lpush", [EVOLVE_KEY, payload]);
    await upstashCommand("ltrim", [EVOLVE_KEY, "0", String(EVOLVE_MAX-1)]);
    return { storage:"upstash" };
  }
  return { storage:"none" };
}

async function evolveStats(){
  if(UP_URL && UP_TOKEN){
    const r = await upstashCommand("llen", [EVOLVE_KEY]);
    const total = r?.result ?? 0;
    return { ok:true, totalEvents: total, storage:"upstash" };
  }
  return { ok:true, totalEvents: 0, storage:"none" };
}

// ===== Health =====
app.get("/", (req,res)=>res.json({ ok:true, service:"YOPO AI PRO API", status:"running" }));
app.get("/ping", (req,res)=>res.send("pong"));

// ✅ Quick diag: see if Binance is blocked (direct) and whether proxy works.
app.get("/api/diag/binance", async (req,res)=>{
  const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
  const interval = String(req.query?.interval || "15m");
  const limit = Math.max(10, Math.min(200, Number(req.query?.limit || 50)));

  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };

  const testUrl = `${BINANCE_FUTURES_BASES[0]}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;

  // direct only (no proxy)
  let direct = null;
  try{
    const r = await fetchWithTimeout(testUrl, { headers }, 10_000);
    if(r.ok){
      const j = await r.json();
      direct = { ok:true, status:r.status, sample:Array.isArray(j) ? j.length : 0 };
    }else{
      const body = await r.text().catch(()=> "");
      direct = { ok:false, status:r.status, body:String(body||"").slice(0, 200) };
    }
  }catch(e){
    direct = { ok:false, status:0, body:String(e?.message||e) };
  }

  // proxy path (uses configured PROXIES)
  const smart = await _fetchJsonSmart(testUrl, { headers, timeoutMs:10_000 });

  res.json({
    ok:true,
    symbol, interval, limit,
    proxiesConfigured: PROXIES.length,
    direct,
    smart: smart.ok ? { ok:true, via:smart.via, sample:Array.isArray(smart.json) ? smart.json.length : 0 } : { ok:false, ...smart.err }
  });
});

// ===== Lightweight helpers for UI =====
app.get("/api/universe/top20", (req,res)=>{
  res.json({ ok:true, symbols: UNIVERSE20 });
});

async function fetchTickerPrice(symbol){
  const key = `ticker:${symbol}`;
  const cached = cacheGet(key, 10_000);
  if(cached) return cached;

  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };

  let lastErr = null;
  for(const base of BINANCE_FUTURES_BASES){
    const url = `${base}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;

    const r = await _fetchJsonSmart(url, { headers, timeoutMs:10_000 });
    if(!r.ok){
      lastErr = r.err;
      continue;
    }

    const j = r.json;
    const price = Number(j?.lastPrice);
    const chg = Number(j?.priceChangePercent);
    if(!Number.isFinite(price)){
      lastErr = { status:0, body:"BAD_TICKER_PRICE", via:r.via };
      continue;
    }

    const out = { price, chg: Number.isFinite(chg) ? chg : 0 };
    cacheSet(key, out);
    return out;
  }

  console.error("[YOPO][fetchTickerPrice] fail", symbol, lastErr?.status || "", lastErr?.via || "", lastErr?.body || "");
  return null;
}

// ===== MARKET TICK =====
app.get("/api/market/tick", async (req,res)=>{
  try{
    const qsSymbol = req.query?.symbol;
    const qsSymbols = req.query?.symbols;

    let list = [];
    if(typeof qsSymbols === "string" && qsSymbols.trim()){
      list = qsSymbols.split(",").map(s=>String(s).trim().toUpperCase()).filter(Boolean);
    }else if(typeof qsSymbol === "string" && qsSymbol.trim()){
      list = [String(qsSymbol).trim().toUpperCase()];
    }else{
      list = ["BTCUSDT"];
    }
    if(list.length > 30) list = list.slice(0, 30);

    const out = {};
    for(const sym of list){
      // 1) try ticker
      let t = await fetchTickerPrice(sym);

      // 2) fallback to last candle close (if ticker fails)
      if(!t){
        const candles = await fetchKlinesSafe(sym, "15m", 50);
        if(candles && candles.length){
          const last = Number(candles[candles.length-1]?.close);
          if(Number.isFinite(last)) t = { price:last, chg:0 };
        }
      }

      if(t && Number.isFinite(t.price)){
        out[sym] = { price: t.price, chgPct: Number(t.chg || 0) };
      }
    }

    // single-symbol mode: keep old shape
    if(list.length === 1 && !qsSymbols){
      const sym = list[0];
      const v = out[sym] || null;
      if(v) return res.json({ ok:true, symbol:sym, price:v.price, chg:v.chgPct });
      return res.json({ ok:false, symbol:sym, error:"NO_TICK", message:"NO_DATA" });
    }

    return res.json({ ok:true, data: out, symbols: list });
  }catch(e){
    console.error("[YOPO][tick]", e?.stack || String(e));
    return res.json({ ok:false, error:"TICK_FAILED", message:String(e?.message||e) });
  }
});


// ===== Engine =====
app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    const symbol = (req.body?.symbol || "BTCUSDT").toUpperCase();
    const tfs = ["15m","30m","1h","4h","1d","1w"];
    const results = [];

    let lastPrice = null;
    try{
      const t = await fetchTickerPrice(symbol);
      if(t && Number.isFinite(t.price)) lastPrice = t.price;
    }catch(_e){}

    for(const tf of tfs){
      const interval = TF_MAP[tf] || tf;
      const candles = await fetchKlinesSafe(symbol, interval, 300);

      if(!candles || candles.length < 60){
        results.push({
          tf,
          action:"HOLD",
          reason:"NO_CANDLES",
          regime:"UNKNOWN",
          pLong:0.5,
          pShort:0.5,
          evLong:-999,
          evShort:-999,
          patternKey:null,
          lastClose: Number.isFinite(lastPrice) ? lastPrice : null
        });
        continue;
      }

      try{
        const ap = atrPctFromCandles(candles, 14);
        const tp = Math.max(0.01, ap*1.4);
        const sl = Math.max(0.01, ap*1.0);
        const out = predict({ symbol, tf, candles, tp, sl });
        out.tpPct = tp;
        out.slPct = sl;

        const lastClose = Number(candles[candles.length-1]?.close);
        results.push({ tf, ...out, lastClose: Number.isFinite(lastClose) ? lastClose : (Number.isFinite(lastPrice) ? lastPrice : null) });
      }catch(e){
        console.error("[YOPO][predict6tf][per_tf]", symbol, tf, String(e?.message||e));
        const lastClose = Number(candles[candles.length-1]?.close);
        results.push({
          tf,
          action:"HOLD",
          reason:"PREDICT_ERR",
          regime:"UNKNOWN",
          pLong:0.5,
          pShort:0.5,
          evLong:-999,
          evShort:-999,
          patternKey:null,
          lastClose: Number.isFinite(lastClose) ? lastClose : (Number.isFinite(lastPrice) ? lastPrice : null)
        });
      }
    }

    let best = null;
    for(const r of results){
      if(r.action==="HOLD") continue;
      const ev = (r.action==="LONG") ? r.evLong : r.evShort;
      if(best===null || ev > best.ev){
        best = { tf:r.tf, action:r.action, ev, regime:r.regime, pLong:r.pLong, pShort:r.pShort, reason:r.reason, lastClose:r.lastClose ?? null };
      }
    }

    res.json({
      ok:true,
      symbol,
      best: best || { action:"HOLD", reason:"ALL_HOLD", lastClose: (results.find(x=>x.lastClose!=null)?.lastClose ?? null) },
      results
    });
  }catch(e){
    console.error("[YOPO][predict6tf]", e?.stack || String(e));
    res.json({ ok:false, message:String(e?.message||e) });
  }
});


app.post("/api/engine/backtest", async (req,res)=>{
  try{
    const symbol = String(req.body?.symbol || "BTCUSDT").toUpperCase();
    const limit = Math.max(240, Math.min(1500, Number(req.body?.limit || 900)));
    const tfs = ["15m","30m","1h","4h","1d","1w"];

    if(!UNIVERSE20.includes(symbol)){
      return res.json({ ok:false, message:`UNKNOWN_SYMBOL: ${symbol}` });
    }

    function atrPct(candles, period=14){
      const n = candles.length;
      if(n < period+1) return 0.01;
      let sum = 0;
      for(let i=n-period;i<n;i++){
        const c = candles[i];
        const p = candles[i-1];
        const tr = Math.max(
          c.high - c.low,
          Math.abs(c.high - p.close),
          Math.abs(c.low - p.close)
        );
        sum += tr;
      }
      const atr = sum/period;
      const last = candles[n-1].close || 1;
      const pct = atr/last;
      return Number.isFinite(pct) && pct>0 ? pct : 0.01;
    }

    function simulateOne(candles, side, tpPct, slPct, startIdx, maxLookahead){
      const entry = candles[startIdx].close;
      const tp = side==="LONG" ? entry*(1+tpPct) : entry*(1-tpPct);
      const sl = side==="LONG" ? entry*(1-slPct) : entry*(1+slPct);

      const end = Math.min(candles.length-1, startIdx + maxLookahead);
      for(let i=startIdx+1;i<=end;i++){
        const h = candles[i].high;
        const l = candles[i].low;

        if(side==="LONG"){
          const hitSL = (l <= sl);
          const hitTP = (h >= tp);
          if(hitSL && hitTP){
            return { outcome:"LOSS", pnl:-slPct };
          }
          if(hitTP) return { outcome:"WIN", pnl:+tpPct };
          if(hitSL) return { outcome:"LOSS", pnl:-slPct };
        }else{
          const hitSL = (h >= sl);
          const hitTP = (l <= tp);
          if(hitSL && hitTP){
            return { outcome:"LOSS", pnl:-slPct };
          }
          if(hitTP) return { outcome:"WIN", pnl:+tpPct };
          if(hitSL) return { outcome:"LOSS", pnl:-slPct };
        }
      }
      return { outcome:"EXPIRE", pnl:0 };
    }

    async function backtestTF(tf){
      const candles = await fetchKlinesSafe(symbol, TF_MAP[tf], limit);
      if(!candles || candles.length < 120){
        return { tf, trades:0, winRate:0, avgPnl:0, holdRate:1, note:"NO_CANDLES" };
      }

      const warm = 80;
      const maxLook = (tf==="15m"||tf==="30m") ? 48 : (tf==="1h") ? 36 : (tf==="4h") ? 24 : 18;

      let decisions = 0;
      let holds = 0;
      let trades = 0;
      let wins = 0;
      let pnlSum = 0;

      for(let i=warm;i<candles.length-2;i++){
        const slice = candles.slice(0, i+1);
        const ap = atrPct(slice, 14);

        const tp = Math.max(0.01, ap*1.4);
        const sl = Math.max(0.01, ap*1.0);

        const r = predict({ symbol, tf, candles: slice, tp, sl });
        const action = r?.action || "HOLD";
        decisions++;

        if(action==="HOLD"){
          holds++;
          continue;
        }

        const sim = simulateOne(candles, action, tp, sl, i, maxLook);
        trades++;
        pnlSum += sim.pnl;
        if(sim.outcome==="WIN") wins++;
      }

      const holdRate = decisions ? (holds/decisions) : 1;
      const winRate = trades ? (wins/trades) : 0;
      const avgPnl = trades ? (pnlSum/trades) : 0;

      return {
        tf,
        trades,
        winRate,
        avgPnl,
        holdRate,
        note: trades < 10 ? "LOW_SAMPLE" : ""
      };
    }

    const results = [];
    for(const tf of tfs){
      results.push(await backtestTF(tf));
    }

    res.json({ ok:true, symbol, limit, results });
  }catch(e){
    console.error("[YOPO][backtest]", e?.stack || String(e));
    res.json({ ok:false, message:String(e?.message||e) });
  }
});

// ===== Evolve =====
app.post("/api/evolve/feedback", async (req,res)=>{
  try{
    const evt = {
      ts: Date.now(),
      symbol: (req.body?.symbol || "").toUpperCase(),
      tf: req.body?.tf || "",
      action: req.body?.action || "",
      win: !!req.body?.win,
      pnl: Number(req.body?.pnl || 0),
      regime: req.body?.regime || "",
      meta: req.body?.meta || {}
    };
    const r = await evolveAppend(evt);
    res.json({ ok:true, stored: r.storage });
  }catch(e){
    res.status(500).json({ ok:false, message:String(e) });
  }
});

app.get("/api/evolve/stats", async (req,res)=>{
  try{
    const s = await evolveStats();
    res.json(s);
  }catch(e){
    res.status(500).json({ ok:false, message:String(e) });
  }
});

app.listen(PORT, ()=>console.log(`[YOPO] Server running on port ${PORT}`));
