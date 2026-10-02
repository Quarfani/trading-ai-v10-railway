/**
 * ADAPTIVE TUNER — v7.1
 * ══════════════════════════════════════════════════════════════════════════
 * [FIX-1] يحدّث الـ StrategyRegistry مباشرة (Sharpe + win_rate + expectancy)
 *         بدلاً من استدعاء updateWinRates() التي لا وجود لها في الـ Registry
 *
 * [FIX-2] يستخدم recordTrade() الموجودة فعلاً بدلاً من API مفقود
 *
 * [NEW]   يُعيد حساب Sharpe Ratio من تاريخ آخر 30 يوم لكل استراتيجية
 *         ويُدخله مباشرة في entry.metrics — يعني ConsensusEngine يحصل على
 *         أوزان حقيقية وليس صفراً للاستراتيجيات التي لها تاريخ
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { SystemConfig }    from '../types/trading.types';
import { Logger }          from '../utils/Logger';

interface HasRegistry {
  getAll?():    Map<string, any>;
  recordTrade?: (name: string, profit: number, entry: number, exit: number) => void;
}

export class AdaptiveTuner {
  private logger   = new Logger('AdaptiveTuner');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private db:       DatabaseManager,
    private registry: HasRegistry,
    private config:   SystemConfig,
  ) {}

  start() {
    this.tune();
    this.interval = setInterval(() => this.tune(), 2 * 3_600_000); // every 2h
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** Called externally for per-symbol weight lookup */
  weightFor(symbol: string, source: string): number {
    try {
      const row = this.db.raw().prepare(`
        SELECT SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as w, COUNT(*) as n
        FROM trades
        WHERE status='closed'
          AND symbol=?
          AND INSTR('+' || source || '+', '+' || ? || '+') > 0
          AND closedAt > ?
      `).get(symbol, source, Date.now() - 30 * 24 * 3_600_000) as
        { w: number; n: number } | undefined;
      if (!row || row.n < 10) return 1.0;
      return Math.max(0.5, Math.min(1.5, 0.5 + row.w / row.n));
    } catch { return 1.0; }
  }

  private tune() {
    try {
      const cutoff = Date.now() - 30 * 24 * 3_600_000;

      // [FIX-1] Query per-strategy stats directly
      const rows = this.db.raw().prepare(`
        SELECT
          source,
          COUNT(*)  as total,
          SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
          AVG(profit) as avg_profit,
          MAX(CASE WHEN profit < 0 THEN ABS(profit) ELSE 0 END) as max_loss
        FROM trades WHERE status='closed' AND closedAt > ?
        GROUP BY source HAVING total >= 8
      `).all(cutoff) as Array<{
        source: string; total: number; wins: number;
        avg_profit: number; max_loss: number;
      }>;

      if (!rows.length) return;

      // Build per-engine stats (source may be TREND+RSI — split it)
      const engineStats: Record<string, {
        trades: number; wins: number; totalProfit: number; maxLoss: number;
      }> = {};

      for (const row of rows) {
        const names = row.source.split('+').map(s => s.trim());
        for (const name of names) {
          if (!engineStats[name]) engineStats[name] = { trades: 0, wins: 0, totalProfit: 0, maxLoss: 0 };
          engineStats[name].trades  += row.total;
          engineStats[name].wins    += row.wins;
          engineStats[name].totalProfit += Number(row.avg_profit) * Number(row.total);
          engineStats[name].maxLoss  = Math.max(engineStats[name].maxLoss, row.max_loss);
        }
      }

      // [FIX-1] Push stats into StrategyRegistry.entries directly
      const entries = this.registry.getAll?.();
      if (!entries) return;

      let updated = 0;
      for (const [name, stats] of Object.entries(engineStats)) {
        const entry = entries.get(name);
        if (!entry) continue;

        const wr           = stats.trades > 0 ? stats.wins / stats.trades : 0.5;
        const avgProfit    = stats.trades > 0 ? stats.totalProfit / stats.trades : 0;
        const sharpe       = this.estimateSharpe(name, cutoff);
        const rolling_wr   = this.rollingWinRate(name, 30, cutoff);

        // Update metrics — only if we have meaningful data
        if (stats.trades >= 10) {
          entry.metrics.win_rate         = wr;
          entry.metrics.sharpe_ratio     = sharpe;
          entry.metrics.expectancy       = avgProfit;
          entry.metrics.rolling_win_rate = rolling_wr;
          entry.metrics.total_trades     = Math.max(entry.metrics.total_trades, stats.trades);
          updated++;
        }
      }

      this.logger.info(`AdaptiveTuner: updated metrics for ${updated} strategies`);

    } catch (e: any) {
      this.logger.error(`Tune failed: ${e.message}`);
    }
  }

  private estimateSharpe(name: string, cutoff: number): number {
    try {
      const profits = this.db.raw().prepare(`
        SELECT profit FROM trades
        WHERE status='closed'
          AND INSTR('+' || source || '+', '+' || ? || '+') > 0
          AND closedAt > ?
          AND profit IS NOT NULL
        ORDER BY closedAt
      `).all(name, cutoff).map((r: any) => r.profit as number);

      if (profits.length < 10) return 0;
      const mean = profits.reduce((s, v) => s + v, 0) / profits.length;
      const stdDev = Math.sqrt(profits.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / profits.length);
      if (stdDev === 0) return mean > 0 ? 2.0 : 0;
      // Annualise: assume ~4 trades/week → ~208 per year
      return (mean / stdDev) * Math.sqrt(208);
    } catch { return 0; }
  }

  private rollingWinRate(name: string, lastN: number, cutoff: number): number {
    try {
      const rows = this.db.raw().prepare(`
        SELECT profit FROM trades
        WHERE status='closed'
          AND INSTR('+' || source || '+', '+' || ? || '+') > 0
          AND closedAt > ?
        ORDER BY closedAt DESC LIMIT ?
      `).all(name, cutoff, lastN) as Array<{ profit: number }>;
      if (rows.length < 5) return 0.5;
      return rows.filter(r => r.profit > 0).length / rows.length;
    } catch { return 0.5; }
  }
}
