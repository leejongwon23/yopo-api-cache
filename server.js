/*************************************************************
 * YOPO AI PRO — server.js (FULL · BINANCE20 · EVOLVE/UPSTASH)
 * ✅ FIX 2026-01-30:
 * 1) scan/backtest 15m 고정 제거 → 20코인×6TF
 * 2) tp/sl 1% 고정 제거 → algo_core 동적 tp/sl 사용
 * 3) scan NaN/edge 이상 방어 + UI필드(winProb/edge/confTier/tpPct/slPct) 제공
 * 4) backtest 실제 결과(overallWinRate 등) 반환 → 웹에서 정상 표시
 *************************************************************/
import express from "express";
import cors from "cors";
import { predict, detectRegime } from "./algo_core.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 20-coin universe (Binance Futures USDT)
const UNIVERSE20 = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","DOTUSDT","LINKUSDT",
  "MATICUSDT","LTCUSDT","BCHUSDT","TRXUSDT","ATOMUSDT",
  "OPUSDT","ARBUSDT","INJUSDT","APTUSDT","SUIUSDT"
];

// 6TF fixed set for YOPO AI PRO (spec): 15m / 30m / 1h / 4h / 1d / 1w
const TFS = ["15m","30m","1h","4h","1d","1w"];
const TF_MAP = {
  "15m":"15m",
  "30m":"30m",
  "1h":"1h",
  "4h":"4h",
  "1d":"1d",
  "1w":"1w",
};

// Binance endpoints can sometimes block certain IP ranges.
// We try multiple base URLs (Futures + Vision + Spot) with a short timeout.
const BINANCE_FUTURES_BASES = [
  "https://fapi.binance.com",
  "https://fapi.binance.vision",
];

const BINANCE_SPOT_BASES = [
  "https://api.binance.com",
  "https://data-api.binance.vision",
];

const BINANCE_TICKER_BASES = [
  ...BINANCE_FUTURES_BASES,
  ...BINANCE_SPOT_BASES,
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

function _normalizeIntervalForSpot(interval){
  return String(interval || "15m");
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

/**
 * ✅ Safe klines fetch:
 * - Tries futures endpoints first, then spot/vision endpoints.
 * - Returns null on failure (never hard-crash engine endpoints).
 * - Caches successful results briefly to reduce upstream pressure.
 */
async function fetchKlinesSafe(symbol, interval="15m", limit=300){
  const key = `klines:${symbol}:${interval}:${limit}`;
  const cached = cacheGet(key, 25_000);
  if(cached) return cached;

  const headers = {
    "accept":"application/json",
    "user-agent":"YOPO-AI-PRO/1.0 (+render)"
  };

  const tries = [];

  // Futures klines
  for(const base of BINANCE_FUTURES_BASES){
    tries.push({
      url: `${base}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${encodeURIComponent(limit)}`,
      kind: "futures"
    });
  }

  // Spot/vision klines (fallback)
  const spotInterval = _normalizeIntervalForSpot(interval);
  for(const base of BINANCE_SPOT_BASES){
    tries.push({
      url: `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(spotInterval)}&limit=${encodeURIComponent(limit)}`,
      kind: "spot"
    });
  }

  let lastErr = null;
  for(const t of tries){
    try{
      const res = await fetchWithTimeout(t.url, { headers }, 12_000);
      if(!res.ok){
        let body = "";
        try{ body = (await res.text()).slice(0, 200); }catch(_e){}
        if(res.status===429 || res.status===418 || res.status===451){
          await sleep(400);
        }
        lastErr = new Error(`BINANCE_${res.status} ${t.url} ${body}`);
        continue;
      }
      const arr = await res.json();
      const candles = _parseKlinesArray(arr);
      if(!candles || candles.length===0){
        lastErr = new Error(`BINANCE_EMPTY ${t.url}`);
        continue;
      }
      cacheSet(key, candles);
      return candles;
    }catch(e){
      lastErr = e;
      continue;
    }
  }

  console.error("[YOPO][fetchKlinesSafe] fail", symbol, interval, limit, String(lastErr?.message || lastErr));
  return null;
}

async function fetchTickerPrice(symbol){
  const key = `ticker:${symbol}`;
  const cached = cacheGet(key, 10_000);
  if(cached) return cached;

  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
  };

  let lastErr = null;
  for(const base of BINANCE_TICKER_BASES){
    const isSpot = base.includes("api.binance.com") || base.includes("data-api.binance.vision");
    const path = isSpot ? "/api/v3/ticker/price" : "/fapi/v1/ticker/price";
    const url = `${base}${path}?symbol=${encodeURIComponent(symbol)}`;
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

// ===== tiny utils =====
function toNum(x, d=0){
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function safeConfTier(winProb, ev){
  const wp = toNum(winProb, 0.5);
  const e = toNum(ev, -999);
  if(wp>=0.62 && e>0) return "HIGH";
  if(wp>=0.55 && e>0) return "MID";
  return "LOW";
}
function chooseEv(action, evLong, evShort){
  if(action==="LONG") return toNum(evLong, -999);
  if(action==="SHORT") return toNum(evShort, -999);
  return -999;
}

// Promise pool (overload 방지)
async function pMapLimit(items, limit, mapper){
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async ()=>{
    while(true){
      const i = idx++;
      if(i>=items.length) return;
      out[i] = await mapper(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ===== Health =====
app.get("/", (req,res)=>res.json({ ok:true, service:"YOPO AI PRO API", status:"running" }));
app.get("/ping", (req,res)=>res.send("pong"));

// ===== Lightweight helpers for UI =====
app.get("/api/universe/top20", (req,res)=>{
  res.json({ ok:true, symbols: UNIVERSE20 });
});

app.get("/api/market/tick", async (req,res)=>{
  try{
    const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
    const data = await fetchTickerPrice(symbol);
    res.json({ ok:true, ...data });
  }catch(e){
    const symbol = String(req.query?.symbol || "BTCUSDT").toUpperCase();
    const key = `ticker:${symbol}`;
    const last = cache.get(key)?.data || null;
    console.error("[YOPO][tick]", e?.stack || String(e));
    if(last && Number.isFinite(last.price)){
      return res.json({ ok:true, ...last, stale:true, warn:"UPSTREAM_TICK_FAILED" });
    }
    return res.json({ ok:false, error:"TICK_FAILED", message:String(e?.message||e), stale:false });
  }
});

// ===== Engine =====

/**
 * 통합예측(6TF)
 * - algo_core가 동적 tp/sl 계산
 * - UI가 바로 쓰는 필드(tpPct/slPct/tp/sl/winProb/edge) 포함
 */
app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    const symbol = (req.body?.symbol || "BTCUSDT").toUpperCase();
    const results = [];

    // best-effort ticker price for UI
    let lastPrice = null;
    try{
      const t = await fetchTickerPrice(symbol);
      if(t && Number.isFinite(t.price)) lastPrice = t.price;
    }catch(_e){}

    // fetch/predict 순차(안정) — 과부하 방지
    for(const tf of TFS){
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
          winProb:0.5,
          edge:0,
          evLong:-999,
          evShort:-999,
          tpPct:null,
          slPct:null,
          tp:null,
          sl:null,
          patternKey:null,
          lastClose: Number.isFinite(lastPrice) ? lastPrice : null
        });
        continue;
      }

      const out = predict({ symbol, tf, candles });
      const lastClose = Number(candles[candles.length-1]?.close);
      results.push({
        tf,
        ...out,
        lastClose: Number.isFinite(lastClose) ? lastClose : (Number.isFinite(lastPrice) ? lastPrice : null)
      });
    }

    // best = max(EV) among non-HOLD
    let best = null;
    for(const r of results){
      if(r.action==="HOLD") continue;
      const ev = chooseEv(r.action, r.evLong, r.evShort);
      if(best===null || ev > best.ev){
        best = { tf:r.tf, action:r.action, ev, regime:r.regime, winProb:r.winProb, edge:r.edge, reason:r.reason, tpPct:r.tpPct, slPct:r.slPct, tp:r.tp, sl:r.sl, lastClose:r.lastClose ?? null };
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

/**
 * 통합 자동스캔(20코인×6TF)
 * - 결과는 UI가 기대하는 flat list로 반환 (winProb/edge/type/tf/confTier/tpPct/slPct/tp/sl)
 * - details: symbol별 6TF 결과(모달 캐시용)
 */
app.post("/api/engine/scan_all", async (req,res)=>{
  try{
    const limit = Math.max(120, Math.min(600, Number(req.body?.limit || 300))); // klines limit
    const concurrency = Math.max(1, Math.min(4, Number(req.body?.concurrency || 2))); // overload 방지

    const details = {}; // symbol -> { tf -> result }
    const flat = [];

    // per symbol sequential list but tf fetch inside with pool(작게)
    for(const symbol of UNIVERSE20){
      const perTf = await pMapLimit(TFS, concurrency, async (tf)=>{
        const candles = await fetchKlinesSafe(symbol, TF_MAP[tf]||tf, limit);
        if(!candles || candles.length < 60){
          let lastPrice = null;
          try{
            const t = await fetchTickerPrice(symbol);
            if(t && Number.isFinite(t.price)) lastPrice = t.price;
          }catch(_e){}
          return {
            tf, action:"HOLD", type:"HOLD",
            reason:"NO_CANDLES",
            regime:"UNKNOWN",
            pLong:0.5, pShort:0.5, winProb:0.5, edge:0,
            evLong:-999, evShort:-999,
            tpPct:null, slPct:null, tp:null, sl:null,
            lastClose:lastPrice
          };
        }
        const out = predict({ symbol, tf, candles });
        const lastClose = Number(candles[candles.length-1]?.close);
        const action = out.action || "HOLD";
        const ev = chooseEv(action, out.evLong, out.evShort);
        return {
          tf,
          ...out,
          type: action,
          lastClose: Number.isFinite(lastClose) ? lastClose : null,
          confTier: safeConfTier(out.winProb, ev),
          isRisk: (out.regime==="CHAOS" || String(out.reason||"").includes("REALITY"))
        };
      });

      // store details
      details[symbol] = {};
      for(const r of perTf){
        details[symbol][r.tf] = r;
      }

      // choose best tf for this symbol
      let best = null;
      for(const r of perTf){
        if(r.type==="HOLD") continue;
        const ev = chooseEv(r.type, r.evLong, r.evShort);
        if(best===null || ev > best.ev){
          best = { ...r, ev };
        }
      }

      if(best){
        flat.push({
          symbol,
          tf: best.tf,
          type: best.type,
          entry: toNum(best.entry, toNum(best.lastClose, 0)),
          tpPct: toNum(best.tpPct, null),
          slPct: toNum(best.slPct, null),
          tp: best.tp ?? null,
          sl: best.sl ?? null,
          winProb: toNum(best.winProb, 0.5),
          edge: toNum(best.edge, 0),
          confTier: best.confTier || "LOW",
          regime: best.regime || "-",
          reason: best.reason || "",
          ev: toNum(best.ev, -999),
          isRisk: !!best.isRisk,
          patternKey: best.patternKey || null,
          lastClose: best.lastClose ?? null
        });
      }else{
        flat.push({
          symbol,
          tf: "15m",
          type: "HOLD",
          entry: 0,
          tpPct: null,
          slPct: null,
          tp: null,
          sl: null,
          winProb: 0.5,
          edge: 0,
          confTier: "LOW",
          regime: "UNKNOWN",
          reason: "ALL_HOLD",
          ev: -999,
          isRisk: false,
          patternKey: null,
          lastClose: null
        });
      }
    }

    // sort by ev desc (then winProb)
    flat.sort((a,b)=>{
      const evd = toNum(b.ev,-999) - toNum(a.ev,-999);
      if(evd!==0) return evd;
      return toNum(b.winProb,0.5) - toNum(a.winProb,0.5);
    });

    res.json({ ok:true, universe: UNIVERSE20, tfs: TFS, results: flat, details });
  }catch(e){
    console.error("[YOPO][scan_all]", e?.stack || String(e));
    res.json({ ok:false, message:String(e?.message||e) });
  }
});

/**
 * 백테스트(서버 계산)
 * - UI가 기대: json.overall.overallWinRate
 * - 매우 가벼운 시뮬레이션 (stride/샘플 제한)
 */
app.post("/api/engine/backtest", async (req,res)=>{
  try{
    const limit = Math.max(180, Math.min(900, Number(req.body?.limit || 600)));
    const tradesPerSeries = Math.max(10, Math.min(80, Number(req.body?.tradesPerSeries || 30)));
    const stride = Math.max(1, Math.min(10, Number(req.body?.stride || 3)));
    const concurrency = Math.max(1, Math.min(3, Number(req.body?.concurrency || 2)));

    // TF별 lookahead bars (대략 만료 감각)
    const LOOKAHEAD = { "15m":18, "30m":18, "1h":16, "4h":12, "1d":8, "1w":6 };

    function decideOutcome(action, entry, tp, sl, futureCandles){
      // tp/sl 어느 쪽이 먼저 닿았는지
      if(!Number.isFinite(entry) || !Number.isFinite(tp) || !Number.isFinite(sl)) return null;
      for(const c of futureCandles){
        const hi = Number(c.high), lo = Number(c.low);
        if(!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
        if(action==="LONG"){
          if(hi >= tp) return { win:true, exit:tp };
          if(lo <= sl) return { win:false, exit:sl };
        }else if(action==="SHORT"){
          if(lo <= tp) return { win:true, exit:tp };
          if(hi >= sl) return { win:false, exit:sl };
        }
      }
      // 만료: 마지막 종가로 정산(미세하게 보수적으로)
      const last = futureCandles[futureCandles.length-1];
      const exit = Number(last?.close);
      if(!Number.isFinite(exit)) return null;
      const pnl = (action==="LONG") ? (exit-entry)/entry : (entry-exit)/entry;
      return { win: pnl>0, exit };
    }

    async function backtestOne(symbol, tf){
      const candles = await fetchKlinesSafe(symbol, TF_MAP[tf]||tf, limit);
      if(!candles || candles.length < 90){
        return { symbol, tf, ok:false, note:"NO_CANDLES", trades:0, win:0, winRate:0 };
      }

      const window = 60;
      const look = LOOKAHEAD[tf] || 16;

      let trades = 0;
      let win = 0;
      let sumPnl = 0;

      // sample points: 균등하게 tradesPerSeries 근처
      const start = window;
      const end = candles.length - look - 1;
      if(end <= start+5) return { symbol, tf, ok:false, note:"TOO_SHORT", trades:0, win:0, winRate:0 };

      // stride 기반으로 훑되 tradesPerSeries 초과하면 중단
      for(let i=end; i>=start && trades < tradesPerSeries; i-=stride){
        const hist = candles.slice(i-window, i);
        const out = predict({ symbol, tf, candles: hist });
        if(out.action!=="LONG" && out.action!=="SHORT") continue;
        if(!Number.isFinite(out.entry) || !Number.isFinite(out.tp) || !Number.isFinite(out.sl)) continue;

        const future = candles.slice(i, i+look);
        const outcome = decideOutcome(out.action, out.entry, out.tp, out.sl, future);
        if(!outcome) continue;

        trades++;
        if(outcome.win) win++;

        const pnl = (out.action==="LONG") ? (outcome.exit-out.entry)/out.entry : (out.entry-outcome.exit)/out.entry;
        if(Number.isFinite(pnl)) sumPnl += pnl;
      }

      const winRate = trades ? (win/trades) : 0;
      const avgPnl = trades ? (sumPnl/trades) : 0;

      return {
        symbol, tf,
        ok:true,
        trades,
        win,
        winRate,
        avgPnl,
        regime: (()=>{
          try{ return detectRegime(candles); }catch(_e){ return "UNKNOWN"; }
        })()
      };
    }

    // run pool across series (20*6)
    const series = [];
    for(const s of UNIVERSE20){
      for(const tf of TFS) series.push({ s, tf });
    }

    const perSeries = await pMapLimit(series, concurrency, (x)=>backtestOne(x.s, x.tf));

    // aggregate
    const perSymbol = {};
    let totalTrades = 0, totalWin = 0, sumPnl = 0;

    for(const r of perSeries){
      perSymbol[r.symbol] = perSymbol[r.symbol] || {};
      perSymbol[r.symbol][r.tf] = r;

      totalTrades += toNum(r.trades, 0);
      totalWin += toNum(r.win, 0);
      sumPnl += toNum(r.avgPnl, 0) * toNum(r.trades, 0);
    }

    const overallWinRate = totalTrades ? (totalWin/totalTrades) : 0;
    const overallAvgPnl = totalTrades ? (sumPnl/totalTrades) : 0;

    // top list for UI
    const top = perSeries
      .filter(x=>x && x.ok && x.trades>=10)
      .sort((a,b)=>{
        const wr = toNum(b.winRate,0)-toNum(a.winRate,0);
        if(wr!==0) return wr;
        return toNum(b.avgPnl,0)-toNum(a.avgPnl,0);
      })
      .slice(0, 20)
      .map(x=>({
        symbol: x.symbol,
        tf: x.tf,
        winRate: x.winRate,
        trades: x.trades,
        avgPnl: x.avgPnl,
        regime: x.regime
      }));

    res.json({
      ok:true,
      universe: UNIVERSE20,
      tfs: TFS,
      overall: {
        totalTrades,
        totalWin,
        overallWinRate,
        overallAvgPnl
      },
      perSymbol,
      top
    });
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
