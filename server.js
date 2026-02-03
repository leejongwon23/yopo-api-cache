/*************************************************************
 * YOPO AI PRO — server.js (FULL · BINANCE20 · EVOLVE/UPSTASH)
 * FIX: Binance 451(restricted location) -> Bybit fallback for ticker/klines
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

// ✅ Bybit fallback (Render에서 Binance 451 뜰 때 살려야 함)
const BYBIT_BASES = [
  "https://api.bybit.com"
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

async function fetchJsonWithTimeout(url, opts={}, timeoutMs=12_000){
  const res = await fetchWithTimeout(url, opts, timeoutMs);
  const txt = await res.text().catch(()=>"");
  let json = null;
  try{ json = txt ? JSON.parse(txt) : null; }catch(_e){}
  return { res, txt, json };
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
  if(!candles) throw new Error("BINANCE_OR_BYBIT_FETCH_FAILED");
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

// ===== Bybit helpers =====
function _toBybitInterval(interval){
  // accepts: "15m","30m","1h","4h","1d","1w" or already "15","30","60","240","D","W"
  const x = String(interval || "15m").toLowerCase();
  if(x === "15m") return "15";
  if(x === "30m") return "30";
  if(x === "1h")  return "60";
  if(x === "4h")  return "240";
  if(x === "1d")  return "D";
  if(x === "1w")  return "W";
  // if caller gives numeric already
  if(/^\d+$/.test(x)) return x;
  return "15";
}

function _parseBybitKlines(json){
  // Bybit v5: result.list = [ [start, open, high, low, close, volume, turnover], ... ]  (DESC)
  const list = json?.result?.list;
  if(!Array.isArray(list) || list.length===0) return null;

  const candles = list.map(row=>{
    const ts = Number(row?.[0]);
    return {
      ts: Number.isFinite(ts) ? ts : Date.now(),
      open: +row?.[1],
      high: +row?.[2],
      low:  +row?.[3],
      close:+row?.[4],
      volume:+row?.[5]
    };
  }).filter(c=>Number.isFinite(c.close));

  // Bybit is DESC -> make ASC
  candles.sort((a,b)=>a.ts-b.ts);
  return candles.length ? candles : null;
}

async function fetchKlinesBybit(symbol, interval="15m", limit=300){
  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };
  const iv = _toBybitInterval(interval);
  for(const base of BYBIT_BASES){
    const url =
      `${base}/v5/market/kline?category=linear` +
      `&symbol=${encodeURIComponent(symbol)}` +
      `&interval=${encodeURIComponent(iv)}` +
      `&limit=${encodeURIComponent(limit)}`;
    try{
      const { res, json, txt } = await fetchJsonWithTimeout(url, { headers }, 12_000);
      if(!res.ok){
        continue;
      }
      // Bybit success: retCode===0
      if(json?.retCode !== 0){
        // sometimes rate-limits etc.
        continue;
      }
      const candles = _parseBybitKlines(json);
      if(candles && candles.length){
        return candles;
      }
    }catch(_e){
      continue;
    }
  }
  return null;
}

/**
 * ✅ Safe klines fetch:
 * - Try Binance Futures first
 * - If Binance blocked (451) or fails, fallback to Bybit
 * - Returns null on total failure
 * - Caches successful results briefly
 */
async function fetchKlinesSafe(symbol, interval="15m", limit=300){
  const key = `klines:${symbol}:${interval}:${limit}`;
  const cached = cacheGet(key, 20_000);
  if(cached) return cached;

  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };

  // 1) Binance attempt
  let lastErr = null;
  for(const base of BINANCE_FUTURES_BASES){
    try{
      const url = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`;
      const res = await fetchWithTimeout(url, { headers }, 12_000);
      if(!res.ok){
        let body = "";
        try{ body = (await res.text()).slice(0, 200); }catch(_e){}
        // 451 is the killer in your logs
        lastErr = new Error(`BINANCE_${res.status} ${body}`);
        // small backoff for 429/418/451
        if(res.status===429 || res.status===418 || res.status===451){
          await sleep(250);
        }
        continue;
      }
      const arr = await res.json();
      const candles = _parseKlinesArray(arr);
      if(!candles || candles.length===0){
        lastErr = new Error(`BINANCE_EMPTY ${url}`);
        continue;
      }
      cacheSet(key, candles);
      return candles;
    }catch(e){
      lastErr = e;
      continue;
    }
  }

  // 2) Bybit fallback
  try{
    const candles = await fetchKlinesBybit(symbol, interval, limit);
    if(candles && candles.length){
      cacheSet(key, candles);
      return candles;
    }
  }catch(_e){}

  console.error("[YOPO][fetchKlinesSafe] fail", symbol, interval, limit, String(lastErr?.message || lastErr));
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

async function fetchTickerPriceBybit(symbol){
  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };
  for(const base of BYBIT_BASES){
    const url = `${base}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`;
    try{
      const { res, json } = await fetchJsonWithTimeout(url, { headers }, 10_000);
      if(!res.ok) continue;
      if(json?.retCode !== 0) continue;
      const item = json?.result?.list?.[0];
      const price = Number(item?.lastPrice);
      const chg = Number(item?.price24hPcnt) * 100; // Bybit is ratio (ex: 0.0123)
      if(!Number.isFinite(price)) continue;
      return { price, chg: Number.isFinite(chg) ? chg : 0 };
    }catch(_e){
      continue;
    }
  }
  return null;
}

async function fetchTickerPrice(symbol){
  const key = `ticker:${symbol}`;
  const cached = cacheGet(key, 10_000);
  if(cached) return cached;

  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };

  // 1) Binance attempt
  let lastErr = null;
  for(const base of BINANCE_FUTURES_BASES){
    try{
      const url = `${base}/fapi/v1/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
      const res = await fetchWithTimeout(url, { headers }, 10_000);
      if(!res.ok){
        let body = "";
        try{ body = (await res.text()).slice(0, 200); }catch(_e){}
        lastErr = new Error(`${res.status} ${body}`);
        continue;
      }
      const j = await res.json();
      const price = Number(j?.lastPrice);
      const chg = Number(j?.priceChangePercent);
      if(!Number.isFinite(price)) throw new Error("BAD_TICKER_PRICE");
      const out = { price, chg: Number.isFinite(chg) ? chg : 0 };
      cacheSet(key, out);
      return out;
    }catch(e){
      lastErr = e;
      continue;
    }
  }

  // 2) Bybit fallback
  try{
    const out = await fetchTickerPriceBybit(symbol);
    if(out && Number.isFinite(out.price)){
      cacheSet(key, out);
      return out;
    }
  }catch(_e){}

  console.error("[YOPO][fetchTickerPrice] fail", symbol, String(lastErr?.message||lastErr));
  return null;
}

app.get("/api/market/tick", async (req,res)=>{
  try{
    // ✅ Supports both:
    // - /api/market/tick?symbol=BTCUSDT
    // - /api/market/tick?symbols=BTCUSDT,ETHUSDT
    const qsSymbol = req.query?.symbol;
    const qsSymbols = req.query?.symbols;

    // Build symbol list
    let list = [];
    if(typeof qsSymbols === "string" && qsSymbols.trim()){
      list = qsSymbols.split(",").map(s=>String(s).trim().toUpperCase()).filter(Boolean);
    }else if(typeof qsSymbol === "string" && qsSymbol.trim()){
      list = [String(qsSymbol).trim().toUpperCase()];
    }else{
      list = ["BTCUSDT"];
    }

    // Limit to avoid abuse (UI needs max 20)
    if(list.length > 30) list = list.slice(0, 30);

    const out = {};
    for(const sym of list){
      let t = await fetchTickerPrice(sym);

      // fallback last candle close (best-effort) -> now also benefits from Bybit klines
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

    // Backward compatibility:
    // If caller used single-symbol mode, return flat shape.
    if(list.length === 1 && !qsSymbols){
      const sym = list[0];
      const v = out[sym] || null;
      if(v){
        return res.json({ ok:true, symbol:sym, price:v.price, chg:v.chgPct });
      }
      // Soft response (still 200)
      return res.json({ ok:false, symbol:sym, error:"NO_TICK", message:"NO_DATA" });
    }

    // Multi-symbol response (recommended for UI)
    return res.json({ ok:true, data: out, symbols: list });
  }catch(e){
    console.error("[YOPO][tick]", e?.stack || String(e));
    // still return 200 so the browser doesn't spam "Failed to load resource" errors
    return res.json({ ok:false, error:"TICK_FAILED", message:String(e?.message||e) });
  }
});

// ===== Engine =====
app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    const symbol = (req.body?.symbol || "BTCUSDT").toUpperCase();
    const tfs = ["15m","30m","1h","4h","1d","1w"]; // spec
    const results = [];

    // fallback last price (best effort)
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
    // 200 with ok:false -> browser won't hard-break
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
            // conservative: SL first
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

        // dynamic tp/sl but never below 1% (rule)
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
