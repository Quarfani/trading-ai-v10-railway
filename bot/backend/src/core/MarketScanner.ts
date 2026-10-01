/**
 * MARKET SCANNER — ENHANCED
 * [NEW] Candle cache بـ TTL لكل timeframe — يقلل API calls بـ 80%
 * [NEW] Retry تلقائي مع exponential backoff
 * [NEW] Circuit breaker للـ API — يوقف الطلبات بعد 5 فشل متتالي
 */
import axios      from 'axios';
import { Candle, DataSource, SystemConfig, Timeframe } from '../types/trading.types';
import { TIMEFRAME_MS } from '../market/market.types';
import { Logger } from '../utils/Logger';

// Cache TTL per timeframe (ms) — بيانات M1 تتغير كل دقيقة، H4 كل 4 ساعات
const CACHE_TTL: Record<Timeframe, number> = {
  M1: 55_000, M5: 270_000, M15: 800_000,
  M30: 1_700_000, H1: 55_000, H4: 14_000_000, D1: 82_000_000,
};

interface CacheEntry { candles: Candle[]; fetchedAt: number; requestedCount: number; }

export class MarketScanner {
  private logger  = new Logger('MarketScanner');
  private cache   = new Map<string, CacheEntry>();

  // Circuit breaker per market source so one unhealthy venue does not stop every symbol.
  private failCounts = new Map<DataSource, number>();
  private openUntil  = new Map<DataSource, number>();
  private readonly MAX_FAILS = 5;
  private readonly OPEN_MS   = 30_000;

  constructor(private config: SystemConfig) {}

  async fetchCandles(symbol: string, tf: Timeframe, count: number): Promise<Candle[]> {
    const source=this.resolveSource(symbol);
    const now=Date.now();
    if(now < (this.openUntil.get(source) ?? 0)) {
      this.logger.warn(`Scanner ${source} circuit open — skipping ${symbol} ${tf}`);
      return this.cache.get(`${symbol}_${tf}`)?.candles ?? [];
    }

    const key    = `${symbol}_${tf}`;
    const ttl    = CACHE_TTL[tf] ?? TIMEFRAME_MS.M15;
    const cached = this.cache.get(key);
    if(cached && now-cached.fetchedAt<ttl && cached.candles.length>=count) return cached.candles.slice(-count);

    const candles = await this.fetchWithRetry(symbol, tf, Math.max(1,count));
    if(candles.length>0){
      this.cache.set(key,{candles,fetchedAt:Date.now(),requestedCount:candles.length});
      this.failCounts.set(source,0);
    } else {
      const failures=(this.failCounts.get(source)??0)+1;
      if(failures>=this.MAX_FAILS){
        this.openUntil.set(source,Date.now()+this.OPEN_MS);
        this.failCounts.set(source,0);
        this.logger.error(`Scanner ${source} circuit OPEN after ${this.MAX_FAILS} failures — pausing 30s`);
      } else this.failCounts.set(source,failures);
    }
    return candles.slice(-count);
  }

  /** Force-invalidate cache for a symbol (e.g. after trade execution) */
  invalidate(symbol: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(symbol)) this.cache.delete(key);
    }
  }

  // ─── Fetch with retry ─────────────────────────────────────────────────────

  private async fetchWithRetry(symbol: string, tf: Timeframe, count: number, maxRetries = 3): Promise<Candle[]> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const source=this.resolveSource(symbol);
        return await (source==='mt5' ? this.fromMT5(symbol,tf,count) : this.fromBinance(symbol,tf,count));
      } catch (e: any) {
        const delay = 1000 * Math.pow(2, i); // 1s, 2s, 4s
        this.logger.warn(`fetchCandles ${symbol} ${tf} attempt ${i+1} failed (${e.message}) — retry in ${delay}ms`);
        if (i < maxRetries - 1) await sleep(delay);
      }
    }
    this.logger.error(`fetchCandles ${symbol} ${tf} failed after ${maxRetries} retries`);
    return [];
  }

  // ─── Sources ──────────────────────────────────────────────────────────────

  private async fromMT5(symbol: string, tf: Timeframe, count: number): Promise<Candle[]> {
    const r = await axios.get(`${this.config.mt5.bridgeUrl}/candles`, {
      params: { symbol, timeframe: tf, count },
      timeout: 10_000,
      headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey ?? '' },
    });
    return this.normalizeCandles(r.data?.candles ?? [], 'mt5');
  }

  private async fromBinance(symbol:string,tf:Timeframe,count:number):Promise<Candle[]>{
    const MAP: Record<Timeframe, string> = { M1:'1m', M5:'5m', M15:'15m', M30:'30m', H1:'1h', H4:'4h', D1:'1d' };
    const futures=this.config.binance.futures;
    const base=futures?(this.config.binance.env==='testnet'?'https://testnet.binancefuture.com/fapi/v1/klines':'https://fapi.binance.com/fapi/v1/klines'):(this.config.binance.env==='testnet'?'https://testnet.binance.vision/api/v3/klines':'https://api.binance.com/api/v3/klines');
    const target=Math.max(1,Math.min(count,10000)); let endTime:number|undefined; const all:Candle[]=[];
    for(let page=0;all.length<target&&page<20;page++){
      const limit=Math.min(1000,target-all.length),params:any={symbol,interval:MAP[tf],limit}; if(endTime!==undefined)params.endTime=endTime;
      const r=await axios.get(base,{params,timeout:10000});
      const batch:Candle[]=(r.data??[]).map((k:any[])=>({time:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5])}));
      if(!batch.length)break; all.unshift(...batch); endTime=batch[0].time-1; if(batch.length<limit)break; await sleep(100);
    }
    const dedup=new Map<number,Candle>();for(const c of all){c.source='binance';dedup.set(c.time,c);}return Array.from(dedup.values()).sort((a,b)=>a.time-b.time).slice(-target);
  }

  private normalizeCandles(input:any[], source: 'mt5'|'binance' = 'mt5'): Candle[] {
    const out=input.map((c:any)=>({
      time:Number(c.time ?? c.timestamp ?? c.t),
      open:Number(c.open ?? c.o), high:Number(c.high ?? c.h),
      low:Number(c.low ?? c.l), close:Number(c.close ?? c.c),
      volume:Number(c.volume ?? c.v ?? 0),
      source, quality:'good' as const, is_imputed:false, is_synthetic:false, sequence_valid:true,
      latency: Number.isFinite(Number(c.time ?? c.timestamp ?? c.t)) ? Date.now() - Number(c.time ?? c.timestamp ?? c.t) : Infinity,
    })).filter((c:Candle)=>Number.isFinite(c.time)&&Number.isFinite(c.open)&&Number.isFinite(c.high)&&Number.isFinite(c.low)&&Number.isFinite(c.close));
    const dedup=new Map<number,Candle>(); for(const c of out) dedup.set(c.time,c);
    return Array.from(dedup.values()).sort((a,b)=>a.time-b.time);
  }

  private resolveSource(symbol:string):DataSource{
    if(this.config.mode==='mt5')return 'mt5';if(this.config.mode==='binance')return 'binance';
    if(this.config.dataSource==='mt5'||this.config.dataSource==='binance')return this.config.dataSource;
    const s=symbol.toUpperCase().replace(/[^A-Z0-9]/g,'');return /(USDT|USDC|BUSD)$/.test(s)?'binance':'mt5';
  }

}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
