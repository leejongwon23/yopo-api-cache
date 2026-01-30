/*************************************************************
 * YOPO AI PRO — server.js (FULL · BINANCE20 · EVOLVE/UPSTASH)
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

// Binance Futures public endpoints can sometimes block certain IP ranges.
// We try multiple base URLs (official + Vision) with a short timeout.
const BINANCE_FAPI_BASES = [
  "https://fapi.binance.com",
  "https://fapi.binance.vision",
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
  const key = `klines:${symbol}:${interval}:${limit}`;
  const cached = cacheGet(key, 20_000);
  if(cached) return cached;

  let lastErr = null;
  for(const base of BINANCE_FAPI_BASES){
    const url = `${base}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try{
      const res = await fetchWithTimeout(url, {
        headers: {
          "accept":"application/json",
          // Some CDNs behave better with an explicit UA.
          "user-agent":"YOPO-AI-PRO/1.0 (+render)"
        }
      }, 12_000);

      if(!res.ok){
        // Read short body for debugging (avoid huge logs)
        let body = "";
        try{ body = (await res.text()).slice(0, 300); }catch(_e){}
        // Mild backoff on rate-limit / bans
        if(res.status===429 || res.status===418 || res.status===451){
          await sleep(400);
        }
        throw new Error(`BINANCE_${res.status} ${url} ${body}`);
      }
      const arr = await res.json();
      const candles = arr.map(k=>({
        ts: k[0],
        open: +k[1],
        high: +k[2],
        low:  +k[3],
        close:+k[4],
        volume:+k[5]
      }));
      cacheSet(key, candles);
      return candles;
    }catch(e){
      lastErr = e;
      // try next base
      continue;
    }
  }
  throw (lastErr || new Error("BINANCE_FETCH_FAILED"));
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
  // store as LPUSH json, then LTRIM
  if(UP_URL && UP_TOKEN){
    const payload = JSON.stringify(eventObj);
    await upstashCommand("lpush", [EVOLVE_KEY, payload]);
    await upstashCommand("ltrim", [EVOLVE_KEY, "0", String(EVOLVE_MAX-1)]);
    return { storage:"upstash" };
  }
  // fallback: no persistent storage if Upstash absent
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

// ===== Lightweight helpers for UI (no heavy compute) =====
app.get("/api/universe/top20", (req,res)=>{
  res.json({ ok:true, symbols: UNIVERSE20 });
});

async function fetchTickerPrice(symbol){
  const key = `ticker:${symbol}`;
  const cached = cacheGet(key, 3_000);
  if(cached) return cached;

  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
  };

  let lastErr = null;
  for(const base of BINANCE_FAPI_BASES){
    const url = `${base}/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`;
    try{
      const res = await fetchWithTimeout(url, { headers }, 8_000);
      if(!res.ok){
        const txt = await res.text().catch(()=> "");
        lastErr = new Error(`TICKER_HTTP_${res.status}:${txt.slice(0,180)}`);
        continue;
      }
      const js = await res.json();
      const out = { symbol: js.symbol || symbol, price: Number(js.price), ts: Date.now(), source: base };
      cacheSet(key, out);
      return out;
    }catch(e){
      lastErr = e;
      continue;
    }
  }
  throw lastErr || new Error("TICKER_FAILED");
}

app.get("/api/market/tick", async (req,res)=>{
  try{
    const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
    const data = await fetchTickerPrice(symbol);
    res.json({ ok:true, ...data });
  }catch(e){
    console.error("[YOPO][tick]", e?.stack || String(e));
    res.status(502).json({ ok:false, error:"TICK_FAILED", message:String(e?.message||e) });
  }
});


// ===== Engine =====
app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    const symbol = (req.body?.symbol || "BTCUSDT").toUpperCase();
    // 6TF fixed set (spec): 15m / 30m / 1h / 4h / 1d / 1w
    const tfs = ["15m","30m","1h","4h","1d","1w"];
    const results = [];
    for(const tf of tfs){
      const candles = await fetchKlines(symbol, TF_MAP[tf] || "15m", 300);
      const out = predict({ symbol, tf, candles, tp:0.01, sl:0.01 });
      results.push({ tf, ...out });
    }
    // choose best EV among non-HOLD; else HOLD
    let best = null;
    for(const r of results){
      if(r.action==="HOLD") continue;
      const ev = (r.action==="LONG") ? r.evLong : r.evShort;
      if(best===null || ev > best.ev){
        best = { tf:r.tf, action:r.action, ev, regime:r.regime, pLong:r.pLong, pShort:r.pShort, reason:r.reason };
      }
    }
    res.json({
      ok:true,
      symbol,
      best: best || { action:"HOLD", reason:"ALL_HOLD" },
      results
    });
  }catch(e){
    console.error("[YOPO][predict6tf]", e?.stack || String(e));
    res.status(500).json({ ok:false, message:String(e) });
  }
});

app.post("/api/engine/scan_all", async (req,res)=>{
  try{
    const tf = "15m";
    const out = [];
    for(const symbol of UNIVERSE20){
      const candles = await fetchKlines(symbol, TF_MAP[tf], 300);
      const r = predict({ symbol, tf, candles, tp:0.01, sl:0.01 });
      out.push({ symbol, tf, ...r });
    }
    // sort by EV desc
    out.sort((a,b)=>{
      const eva = (a.action==="LONG") ? (a.evLong||-999) : (a.action==="SHORT") ? (a.evShort||-999) : -999;
      const evb = (b.action==="LONG") ? (b.evLong||-999) : (b.action==="SHORT") ? (b.evShort||-999) : -999;
      return evb - eva;
    });
    res.json({ ok:true, tf, universe: UNIVERSE20, results: out });
  }catch(e){
    console.error("[YOPO][scan_all]", e?.stack || String(e));
    res.status(500).json({ ok:false, message:String(e) });
  }
});

app.post("/api/engine/backtest", async (req,res)=>{
  try{
    // Lightweight backtest stub: uses regime distribution over last 300 candles for each symbol
    const tf = "15m";
    const stats = [];
    for(const symbol of UNIVERSE20){
      const candles = await fetchKlines(symbol, TF_MAP[tf], 300);
      const regime = detectRegime(candles);
      stats.push({ symbol, tf, regime });
    }
    res.json({ ok:true, tf, universe: UNIVERSE20, stats });
  }catch(e){
    console.error("[YOPO][backtest]", e?.stack || String(e));
    res.status(500).json({ ok:false, message:String(e) });
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
