/**
 * WIN RATE UPDATER
 * Runs every hour — recalculates per-strategy win rates from closed trades
 * and pushes them to DecisionEngine so scoring stays accurate over time.
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { DecisionEngine }  from '../decision/DecisionEngine';
import { Logger }          from '../utils/Logger';

export class WinRateUpdater {
  private logger   = new Logger('WinRateUpdater');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private db:       DatabaseManager,
    private decision: DecisionEngine,
  ) {}

  start() {
    this.update();
    this.interval = setInterval(() => this.update(), 3_600_000); // every hour
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private update() {
    try {
      const rows = this.db.raw().prepare(`
        SELECT
          source,
          COUNT(*) as total,
          SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins
        FROM trades
        WHERE status = 'closed'
          AND source IS NOT NULL
          AND openedAt > ?
        GROUP BY source
        HAVING total >= 10
      `).all(Date.now() - 30 * 24 * 3_600_000) as Array<{
        source: string; total: number; wins: number;
      }>;

      if (!rows.length) return;

      const rates: Record<string, number> = {};
      for (const row of rows) {
        // source can be "TREND+RSI" — credit each engine individually
        const engines = row.source.split('+');
        const wr = row.wins / row.total;
        for (const eng of engines) {
          // Weighted average if engine appears in multiple sources
          rates[eng] = rates[eng]
            ? (rates[eng] + wr) / 2
            : wr;
        }
      }

      this.decision.updateWinRates(rates);
      this.logger.info(`Win rates updated: ${JSON.stringify(
        Object.fromEntries(Object.entries(rates).map(([k,v]) => [k, `${(v*100).toFixed(1)}%`]))
      )}`);
    } catch (e: any) {
      this.logger.error(`Win rate update failed: ${e.message}`);
    }
  }
}
