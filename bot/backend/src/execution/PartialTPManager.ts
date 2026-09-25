/**
 * PARTIAL TP MANAGER — v2.0
 * FIX BUG-C4: paper mode used hardcoded 'M1' timeframe AND hardcoded
 *   contractSize 100,000, causing wildly wrong PnL for gold/crypto.
 * FIX BUG-C5: taken Set was in-memory only. On bot restart, every trade
 *   that already had a partial close would receive a second partial close.
 *   Fix: persist taken IDs to the database under key 'partial_tp_taken'.
 */
import { SystemConfig } from '../types/trading.types';
import { DatabaseManager }  from '../database/DatabaseManager';
import { ExecutionGateway } from './ExecutionGateway';
import { MarketScanner }    from '../core/MarketScanner';
import { getSymbolSpec }    from '../config/symbolConfig';
import { Logger }           from '../utils/Logger';

// Map trade timeframe to a suitable candle-fetch timeframe
const TF_MAP: Record<string, string> = {
  M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M15',
  H1: 'H1', H4: 'H1', D1: 'H4',
};

const PARTIAL_TAKEN_DB_KEY = 'partial_tp_taken';

export class PartialTPManager {
  private logger   = new Logger('PartialTP');
  private interval: NodeJS.Timeout | null = null;

  // FIX BUG-C5: persisted across restarts — loaded from DB on start()
  private taken = new Set<number>();

  constructor(
    private config:  SystemConfig,
    private db:      DatabaseManager,
    private orders:  ExecutionGateway,
    private scanner: MarketScanner,
  ) {}

  start() {
    // FIX BUG-C5: load previously-taken IDs from DB to survive restarts
    this.loadTaken();
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private loadTaken(): void {
    try {
      const raw = this.db.getSetting(PARTIAL_TAKEN_DB_KEY);
      if (raw) {
        const ids: number[] = JSON.parse(raw);
        ids.forEach(id => this.taken.add(id));
        this.logger.info(`Loaded ${ids.length} partial-TP records from DB`);
      }
    } catch { /* no record yet — fresh start */ }
  }

  private saveTaken(): void {
    try {
      this.db.setSetting(PARTIAL_TAKEN_DB_KEY, JSON.stringify([...this.taken]));
    } catch { /* non-critical */ }
  }

  private async tick() {
    const open = this.db.getOpenTrades();

    for (const t of open) {
      if (!t.id || this.taken.has(t.id)) continue;

      // FIX BUG-C4: use the trade's own timeframe for price check
      const rawTF  = (t as any).timeframe ?? 'M5';
      const fetchTF = TF_MAP[rawTF] ?? 'M5';

      const candles = await this.scanner
        .fetchCandles(t.symbol, fetchTF as any, 5)
        .catch(() => []);
      if (!candles.length) continue;

      const price = candles[candles.length - 1].close;
      const r     = Math.abs(t.entry - t.sl);
      const moved = t.side === 'BUY' ? price - t.entry : t.entry - price;

      if (moved < r) continue; // not yet at 1R

      try {
        await this.doPartialClose(t, price);
        this.taken.add(t.id);
        this.saveTaken(); // FIX BUG-C5: persist immediately
        this.logger.info(
          `Partial TP ${t.symbol} id=${t.id} at 1R (price=${price.toFixed(5)})`,
        );
      } catch (e: any) {
        this.logger.warn(`Partial close failed ${t.symbol}: ${e.message}`);
      }
    }

    // Prune IDs that are no longer open (closed trades) to keep the set small
    const openIds = new Set(open.map(t => t.id!));
    for (const id of this.taken) {
      if (!openIds.has(id)) this.taken.delete(id);
    }
    this.saveTaken();
  }

  private async doPartialClose(t: any, currentPrice: number) {
    const volume=+(t.volume*0.5).toFixed(8);
    if(!(volume>0)||volume>=t.volume) throw new Error(`Invalid partial volume for ${t.symbol}`);
    const result=await this.orders.closePartial(t,volume,currentPrice,'PARTIAL_1R');
    if(!result.ok) throw new Error(`Partial close failed for ${t.symbol}`);
    this.logger.info(`[${this.config.mode}] Partial TP ${t.symbol}: closed=${volume} @ ${currentPrice.toFixed(5)} remaining=${result.remainingVolume.toFixed(8)} PnL=${result.profit.toFixed(2)}`);
  }
}
