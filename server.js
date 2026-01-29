import express from "express";

const app = express();
app.use(express.json());

// ===== Health =====
app.get(["/","/ping"], (req,res)=>{
  res.json({ ok:true, ts:Date.now() });
});

// ===== Engine (POST only) =====
app.post("/api/engine/predict6tf", async (req,res)=>{
  try{
    res.json({ ok:true, note:"ENGINE_OK", data:req.body||{} });
  }catch(e){
    res.status(500).json({ error:"ENGINE_ERROR" });
  }
});

app.post("/api/engine/scan_all", async (req,res)=>{
  try{
    res.json({ ok:true, note:"SCAN_OK" });
  }catch(e){
    res.status(500).json({ error:"SCAN_ERROR" });
  }
});

app.post("/api/engine/backtest", async (req,res)=>{
  try{
    res.json({ ok:true, note:"BACKTEST_OK" });
  }catch(e){
    res.status(500).json({ error:"BACKTEST_ERROR" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{
  console.log("Listening on", PORT);
  console.log("EVOLVE_PERSIST: UPSTASH");
});
