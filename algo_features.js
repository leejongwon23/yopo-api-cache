/*************************************************************
 * YOPO AI PRO — algo_features.js (LIGHT)
 * 역할:
 * - 서버(algo_core)가 필요할 때 쓸 수 있는 '가벼운' 보조 피처 계산
 * 원칙:
 * - 예측 결과를 바꾸지 않음(부가 정보용)
 *************************************************************/
export function computeFeatures(candles){
  if(!Array.isArray(candles) || candles.length < 3) return { ret1:0, vol:0 };
  const c = candles;
  const last = Number(c[c.length-1]?.close || 0);
  const prev = Number(c[c.length-2]?.close || last || 1);
  const ret1 = (prev!==0) ? (last/prev - 1) : 0;

  // simple volatility (avg abs return over last 20)
  const n = Math.min(20, c.length-1);
  let sum = 0;
  for(let i=c.length-n;i<c.length;i++){
    const a = Number(c[i-1]?.close||0), b = Number(c[i]?.close||0);
    if(a>0 && b>0) sum += Math.abs(b/a - 1);
  }
  const vol = n>0 ? (sum/n) : 0;
  return { ret1, vol };
}
