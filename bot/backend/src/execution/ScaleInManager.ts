/**
 * SCALE-IN MANAGER — v2.0
 * FIX: scaled Set was in-memory only — reset on every bot restart.
 * Trades that already received a scale-in got a second scale-in after restart.
 * Fix: persist scaled IDs to SQLite using db.setSetting().
 */
import { SystemConfig }        from '../types/trading.types';
import { DatabaseManager }     from '../database/DatabaseManager';
import { ExecutionGateway }    from './ExecutionGateway';
import { getSymbolSpec }       from '../config/symbolConfig';
import { Logger }              from '../utils/Logger';
import { MarketScanner }       from '../core/MarketScanner';
import { Signal }               from '../types/trading.types';

const SCALE_DB_KEY = 'scalein_taken';

export class ScaleInManager {
  private logger   = new Logger('ScaleIn');
  private interval: NodeJS.Timeout | null = null;

  // FIX: persisted across restarts
  private scaled = new Set<number>();

  constructor(
    private config: SystemConfig,
    private db:     DatabaseManager,
    private exec:   ExecutionGateway,
    private scanner: MarketScanner,
  ) {}

  start() {
    // FIX: load previously-scaled IDs from DB on startup
    this.loadScaled();
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private loadScaled(): void {
    try {
      const raw = this.db.getSetting(SCALE_DB_KEY);
      if (raw) {
        const ids: number[] = JSON.parse(raw);
        ids.forEach(id => this.scaled.add(id));
        this.logger.info(`Loaded ${ids.length} scale-in records from DB`);
      }
    } catch { /* fresh start */ }
  }

  private saveScaled(): void {
    try {
      this.db.setSetting(SCALE_DB_KEY, JSON.stringify([...this.scaled]));
    } catch { /* non-critical */ }
  }

  private async tick() {
    const open = this.db.getOpenTrades();

    for (const t of open) {
      if (!t.id || this.scaled.has(t.id)) continue;

      const price = await this.getCurrentPrice(t.symbol);
      if (!price) continue;

      const r     = Math.abs(t.entry - t.sl);
      const moved = t.side === 'BUY' ? price - t.entry : t.entry - price;

      // Scale in at 1.5R
      if (moved < r * 1.5) continue;

      try {
        await this.doScaleIn(t, price);
        this.scaled.add(t.id);
        this.saveScaled(); // persist immediately
        this.logger.info(
          `Scale-in ${t.symbol} id=${t.id} at 1.5R (price=${price.toFixed(5)})`
        );
      } catch (e: any) {
        this.logger.warn(`Scale-in failed ${t.symbol}: ${e.message}`);
      }
    }

    // Prune closed trades from the set
    const openIds = new Set(open.map((t: any) => t.id!));
    for (const id of this.scaled) {
      if (!openIds.has(id)) this.scaled.delete(id);
    }
    this.saveScaled();
  }

  private async doScaleIn(t:any,currentPrice:number){
    const spec=getSymbolSpec(t.symbol);
    const addVolume=Math.floor((t.volume*0.5)/spec.volumeStep)*spec.volumeStep;
    if(addVolume<spec.minVolume)throw new Error(`Scale-in volume below minimum for ${t.symbol}`);
    const signal:Signal={symbol:t.symbol,side:t.side,price:currentPrice,confidence:1,sl:t.sl,tp:t.tp,source:`SCALE_IN:${t.source}`,reason:`Scale-in at 1.5R from trade ${t.id}`,timestamp:Date.now(),timeframe:t.timeframe};
    const result=await this.exec.execute(signal,addVolume,t.timeframe??'H1');
    if(!result.success)throw new Error(result.error??'scale-in failed');
  }

  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const candles = await this.scanner.fetchCandles(symbol, 'M5', 1);
      return candles?.[candles.length - 1]?.close ?? null;
    } catch { return null; }
  }
}
