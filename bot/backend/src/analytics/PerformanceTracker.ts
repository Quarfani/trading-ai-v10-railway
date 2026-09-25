/**
 * PERFORMANCE TRACKER — v7.1
 * [FIX] يحفظ account snapshot في DB عند كل إغلاق صفقة
 * [NEW] calculates equity high-water mark
 * [NEW] getStrategyBreakdown() — per-strategy stats for API
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { SystemConfig, StrategyPerformance } from '../types/trading.types';

export class PerformanceTracker {
  private equity: number;

  constructor(private db: DatabaseManager, private config: SystemConfig) {
    const saved = db.getSetting('current_equity');
    this.equity = saved ? Number(saved) : config.accountBalance;
  }

  recordClose(profit: number) {
    if (this.config.compounding?.enabled) {
      const reinvest = profit > 0 ? profit * this.config.compounding.reinvestRate : profit;
      this.equity += reinvest;
    } else {
      this.equity += profit;
    }
    this.db.setSetting('current_equity', String(this.equity));
    // [FIX] Persist equity snapshot for drawdown curve
    this.db.saveAccountSnapshot(this.equity, this.equity);
  }

  getCurrentEquity(): number { return this.equity; }

  summary() {
    const today = this.db.getTodayStats() ?? { trades: 0, wins: 0, losses: 0, pnl: 0 };
    const all = this.db.raw().prepare(`
      SELECT COUNT(*) as total,
             SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) as wins,
             SUM(CASE WHEN profit <= 0 AND status='closed' THEN 1 ELSE 0 END) as losses,
             COALESCE(SUM(profit),0) as totalPnl,
             COALESCE(AVG(profit),0) as avgTrade,
             COALESCE(MAX(profit),0) as bestTrade,
             COALESCE(MIN(profit),0) as worstTrade
      FROM trades WHERE status='closed'
    `).get() as any;

    const winrate = all.total ? all.wins / all.total : 0;

    // Profit factor
    const pf = this.db.raw().prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN profit>0 THEN profit ELSE 0 END),0) grossWin,
        COALESCE(SUM(CASE WHEN profit<=0 THEN -profit ELSE 0 END),0) grossLoss
      FROM trades WHERE status='closed'
    `).get() as any;
    const profitFactor = pf.grossLoss > 0 ? pf.grossWin / pf.grossLoss : 0;

    return { today, all, winrate, equity: this.equity, profitFactor };
  }

  // [NEW] Per-strategy breakdown for API
  getStrategyBreakdown(days = 30): StrategyPerformance[] {
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    const rows = this.db.raw().prepare(`
      SELECT source,
             COUNT(*) total,
             SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END) wins,
             AVG(profit) expectancy
      FROM trades WHERE status='closed' AND openedAt > ?
      GROUP BY source ORDER BY total DESC
    `).all(cutoff) as any[];

    return rows.map(r => {
      const name    = r.source.split('+')[0];
      const metrics = this.db.getStrategyMetrics(name);
      return {
        name:           r.source,
        enabled:        true,
        totalTrades:    r.total,
        winRate:        r.total > 0 ? r.wins / r.total : 0,
        sharpeRatio:    metrics?.sharpe_ratio ?? 0,
        rollingWinRate: metrics?.rolling_win_rate ?? 0.5,
        expectancy:     r.expectancy ?? 0,
        maxDrawdown:    metrics?.max_drawdown ?? 0,
      };
    });
  }

  shouldGraduateToBinance(): boolean {
    if (this.config.mode !== 'mt5') return false;
    const s = this.summary();
    return (s.all.total ?? 0) >= (this.config.graduation?.minTrades ?? 9999)
        && (s.winrate ?? 0) >= (this.config.graduation?.winrateThreshold ?? 1);
  }
}
