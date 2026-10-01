/**
 * BREAKEVEN MANAGER — v2.0
 * FIX: movedBE Set was in-memory only — reset on every bot restart.
 * On restart: trades that already had SL moved to breakeven would
 * have it "moved" again — which is harmless IF the broker already
 * has the correct SL, but wastes API calls and can cause confusion.
 * Fix: persist movedBE IDs to SQLite using db.setSetting().
 */
import { SystemConfig }       from '../types/trading.types';
import { DatabaseManager }    from '../database/DatabaseManager';
import { MarketScanner }      from '../core/MarketScanner';
import { ExecutionGateway }   from './ExecutionGateway';
import { Logger }             from '../utils/Logger';
import { getMarketDefinition } from '../market/MarketCatalog';

const BE_DB_KEY = 'breakeven_moved';

// Map trade timeframe → fetch timeframe
const TF_MAP: Record<string, string> = {
  M1: 'M1', M5: 'M5', M15: 'M15', M30: 'M15',
  H1: 'H1', H4: 'H1', D1: 'H4',
};

export class BreakevenManager {
  private logger   = new Logger('Breakeven');
  private interval: NodeJS.Timeout | null = null;

  // FIX: persisted across restarts
  private movedBE = new Set<number>();

  constructor(
    private config:  SystemConfig,
    private db:      DatabaseManager,
    private scanner: MarketScanner,
    private exec?:   ExecutionGateway,
  ) {}

  start() {
    this.loadMovedBE();
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private loadMovedBE(): void {
    try {
      const raw = this.db.getSetting(BE_DB_KEY);
      if (raw) {
        const ids: number[] = JSON.parse(raw);
        ids.forEach(id => this.movedBE.add(id));
        this.logger.info(`Loaded ${ids.length} breakeven records from DB`);
      }
    } catch { /* fresh start */ }
  }

  private saveMovedBE(): void {
    try {
      this.db.setSetting(BE_DB_KEY, JSON.stringify([...this.movedBE]));
    } catch { /* non-critical */ }
  }

  private async tick() {
    const open = this.db.getOpenTrades();

    for (const t of open) {
      if (!t.id || this.movedBE.has(t.id)) continue;

      // Get current price using trade's own timeframe
      const rawTF   = (t as any).timeframe ?? 'H1';
      const fetchTF = TF_MAP[rawTF] ?? 'H1';
      const candles = await this.scanner
        .fetchCandles(t.symbol, fetchTF as any, 3)
        .catch(() => []);
      if (!candles.length) continue;

      const price = candles[candles.length - 1].close;
      const r     = Math.abs(t.entry - t.sl);
      const moved = t.side === 'BUY' ? price - t.entry : t.entry - price;

      // Move SL to breakeven+1pip when trade is at 1R profit
      if (moved < r) continue;

      const market = getMarketDefinition(t.symbol);
      if (!market) {
        this.logger.warn(`Breakeven blocked ${t.symbol}: broker market definition unavailable`);
        continue;
      }

      // Use the broker's minimum executable price increment instead of a
      // universal 0.0001 pip. This remains valid for JPY FX, Gold, Oil and
      // suffixed MT5 symbols with broker-specific point sizes.
      const priceBuffer = market.economics.priceIncrement;
      const newSL   = t.side === 'BUY'
        ? t.entry + priceBuffer
        : t.entry - priceBuffer;

      // Don't move if already at or better than breakeven
      if (t.side === 'BUY'  && t.sl >= newSL) { this.movedBE.add(t.id); this.saveMovedBE(); continue; }
      if (t.side === 'SELL' && t.sl <= newSL) { this.movedBE.add(t.id); this.saveMovedBE(); continue; }

      try {
        if (this.exec) {
          const ok = await this.exec.modifySLTP(t as any, newSL, t.tp);
          if (!ok) throw new Error('Broker rejected breakeven SL modification');
        }
        // Update DB
        this.db.raw()
          .prepare("UPDATE trades SET sl=? WHERE id=? AND status='open'")
          .run(newSL, t.id);

        this.movedBE.add(t.id);
        this.saveMovedBE();

        this.logger.info(
          `Breakeven: ${t.symbol} id=${t.id} ` +
          `SL moved from ${t.sl.toFixed(5)} → ${newSL.toFixed(5)}`
        );
      } catch (e: any) {
        this.logger.warn(`Breakeven move failed ${t.symbol}: ${e.message}`);
      }
    }

    // Prune closed trades
    const openIds = new Set(open.map((t: any) => t.id!));
    for (const id of this.movedBE) {
      if (!openIds.has(id)) this.movedBE.delete(id);
    }
    this.saveMovedBE();
  }
}
