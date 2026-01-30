/*************************************************************
 * YOPO AI PRO — server.js (FULL · BINANCE20 · EVOLVE/UPSTASH)
 *************************************************************/
import express from "express";
import cors from "cors";
import { predict, detectRegime } from "./algo_core.js";
import { buildDecayedStats } from "./algo_features.js";

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

const TF_MAP = { "5m":"5m", "15m":"15m", "30m":"30m", "1h":"1h", "4h":"4h", "1d":"1d", "1w":"1w" };

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
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { "accept":"application/json" } });
  if(!res.ok) throw new Error("BINANCE_"+res.status);
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


async function evolveFetchRecent(limit=2000){
  if(!(UP_URL && UP_TOKEN)) return [];
  const r = await upstashCommand("lrange", [EVOLVE_KEY, "0", String(Math.max(0, limit-1))]);
  const arr = r?.result || [];
  const out = [];
  for(const s of arr){
    try{ out.push(JSON.parse(s)); }catch(e){}
  }
  return out;
}

async function getMemoryStats(){
  const events = await evolveFetchRecent(2000);
  return buildDecayedStats(events, { halfLifeDays: 7, maxAgeDays: 60 });
}

// ===== Health =====
app.get("/", (req,res)=>res.json({ ok:true, service:"YOPO AI PRO API", status:"running" }));
app.get("/ping", (req,res)=>res.send("pong"));

// ===== Engine =====
app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    const symbol = (req.body?.symbol || "BTCUSDT").toUpperCase();
    const tfs = ["15m","30m","1h","4h","1d","1w"]; // 6 slots; 15m duplicated as micro-consensus slot
    const results = [];
    const memoryStats = await getMemoryStats();
    for(const tf of tfs){
      const candles = await fetchKlines(symbol, TF_MAP[tf] || "15m", 300);
      const out = predict({ symbol, tf, candles, tp:0.01, sl:0.005, memoryStats });
      const lastClose = candles?.length ? candles[candles.length-1].close : null;
      results.push({ tf, lastClose, ...out });
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
    res.status(500).json({ ok:false, message:String(e) });
  }
});

app.post("/api/engine/scan_all", async (req,res)=>{
  try{
    const tfs = ["15m","30m","1h","4h","1d","1w"];
    const memoryStats = await getMemoryStats();

    const perSymbol = [];
    const flat = [];

    for(const symbol of UNIVERSE20){
      const rows = [];
      for(const tf of tfs){
        const candles = await fetchKlines(symbol, TF_MAP[tf] || "15m", 300);
        const r = predict({ symbol, tf, candles, tp:0.01, sl:0.005, memoryStats });
        const lastClose = candles?.length ? candles[candles.length-1].close : null;
        const ev = (r.action==="LONG") ? (r.evLong ?? -999) : (r.action==="SHORT") ? (r.evShort ?? -999) : -999;
        const row = { symbol, tf, lastClose, ev, ...r };
        rows.push(row);
        flat.push(row);
      }
      const best = rows.reduce((a,b)=> (b.ev>a.ev ? b : a), rows[0]);
      perSymbol.push({ symbol, best, rows });
    }

    flat.sort((a,b)=>(b.ev||-999)-(a.ev||-999));
    res.json({ ok:true, universe: UNIVERSE20, tfs, perSymbol, results: flat });
  }catch(e){
    res.status(500).json({ ok:false, message:String(e) });
  }
});

app.post("/api/engine/backtest", async (req,res)=>{
  try{
    const tfs = ["15m","30m","1h","4h","1d","1w"];
    const memoryStats = await getMemoryStats();

    const limit = Math.min(900, Math.max(400, Number(req.body?.limit || 600)));
    const tp = 0.01;
    const sl = 0.005;
    const minWarm = 120;
    const horizon = 18;

    const report = [];

    for(const symbol of UNIVERSE20){
      for(const tf of tfs){
        const candles = await fetchKlines(symbol, TF_MAP[tf] || "15m", limit);
        let win=0, lose=0, hold=0;

        for(let i=minWarm; i<candles.length-horizon; i++){
          const window = candles.slice(i-minWarm, i);
          const r = predict({ symbol, tf, candles: window, tp, sl, memoryStats });
          if(r.action==="HOLD"){ hold++; continue; }

          const entry = window[window.length-1].close;
          const tpPx = (r.action==="LONG") ? entry*(1+tp) : entry*(1-tp);
          const slPx = (r.action==="LONG") ? entry*(1-sl) : entry*(1+sl);

          let outcome = null;
          for(let j=i; j<i+horizon; j++){
            const c = candles[j];
            if(r.action==="LONG"){
              if(c.high >= tpPx){ outcome=true; break; }
              if(c.low  <= slPx){ outcome=false; break; }
            }else{
              if(c.low  <= tpPx){ outcome=true; break; }
              if(c.high >= slPx){ outcome=false; break; }
            }
          }

          if(outcome===true) win++;
          else if(outcome===false) lose++;
          else hold++;
        }

        const samples = win+lose;
        const winRate = samples>0 ? (win/samples) : 0;
        report.push({ symbol, tf, samples, win, lose, hold, winRate });
      }
    }

    report.sort((a,b)=>{
      const wa = (a.samples>=20)?1:0;
      const wb = (b.samples>=20)?1:0;
      if(wa!==wb) return wb-wa;
      if((b.winRate||0)!==(a.winRate||0)) return (b.winRate||0)-(a.winRate||0);
      return (b.samples||0)-(a.samples||0);
    });

    const totalWin = report.reduce((s,r)=>s+(r.win||0),0);
    const totalLose = report.reduce((s,r)=>s+(r.lose||0),0);
    const overallWinRate = (totalWin+totalLose)>0 ? totalWin/(totalWin+totalLose) : 0;

    res.json({
      ok:true,
      universe: UNIVERSE20,
      tfs,
      params:{ limit, tp, sl, horizon, minWarm },
      overall:{ totalWin, totalLose, overallWinRate },
      report
    });
  }catch(e){
    res.status(500).json({ ok:false, message:String(e) });
  }
});

// ===== Evolve =====
app.post("/api/evolve/feedback", async (req,res)=>{
  try{
    const evt = {
      ts: Date.now(),
      symbol: (req.body?.symbol || "").toUpperCase(),
      tf: String(req.body?.tf || ""),
      action: String(req.body?.action || ""),
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
