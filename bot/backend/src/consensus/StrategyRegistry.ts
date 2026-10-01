/**
 * STRATEGY REGISTRY
 * ══════════════════════════════════════════════════════════════════════════
 * Central registry for all trading strategies.
 *
 * Responsibilities:
 *   - Register / deregister strategies at runtime
 *   - Enable / disable strategies dynamically
 *   - Maintain rolling performance metrics per strategy
 *   - Expose active strategies to ConsensusEngine
 *   - Persist metrics to DB for cross-restart continuity
 *
 * Thread safety: single-threaded Node.js — no locking needed.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  IStrategy, RegistryEntry, StrategyMetrics,
  TradeRecord, ConsensusConfig, DEFAULT_CONSENSUS_CONFIG,
} from './types';
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger }          from '../utils/Logger';
import { StrategyDefinitionStore } from './StrategyDefinitionStore';
import { EvidencePromotionPolicy, DEFAULT_EVIDENCE_PROMOTION_POLICY } from './EvidencePromotionPolicy';

const EMPTY_METRICS: StrategyMetrics = {
  win_rate: 0.50, sharpe_ratio: 0, max_drawdown: 0,
  expectancy: 0, rolling_win_rate: 0.50, rolling_expectancy: 0,
  total_trades: 0, rolling_trades: 0,
};

export class StrategyRegistry {
  private readonly logger   = new Logger('StrategyRegistry');
  private readonly entries  = new Map<string, RegistryEntry>();
  private readonly cfg:     ConsensusConfig;
  private readonly definitionStore: StrategyDefinitionStore;

  constructor(
    private readonly db: DatabaseManager,
    cfg: Partial<ConsensusConfig> = {},
    evidencePolicy: EvidencePromotionPolicy = DEFAULT_EVIDENCE_PROMOTION_POLICY,
    private readonly initialEquity = 10_000,
  ) {
    this.cfg = { ...DEFAULT_CONSENSUS_CONFIG, ...cfg, gate: { ...DEFAULT_CONSENSUS_CONFIG.gate, ...(cfg.gate ?? {}) } };
    this.definitionStore = new StrategyDefinitionStore(db, evidencePolicy);
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  register(strategy: IStrategy): void {
    if (this.entries.has(strategy.name)) {
      this.logger.warn(`Strategy '${strategy.name}' already registered — skipping`);
      return;
    }

    const persisted = this.loadMetrics(strategy.name);
    const definition = this.definitionStore.getByName(strategy.name);
    const entry: RegistryEntry = {
      strategy,
      enabled:     definition ? definition.enabled : true,
      definition:  definition ?? undefined,
      metrics:     persisted ?? { ...EMPTY_METRICS },
      tradeWindow: [],
    };

    this.entries.set(strategy.name, entry);
    this.logger.info(`Registered strategy: ${strategy.name} (${persisted ? 'metrics loaded from DB' : 'fresh start'})`);
  }

  deregister(name: string): void {
    if (this.entries.delete(name)) {
      this.logger.info(`Deregistered strategy: ${name}`);
    }
  }

  // ─── Enable / Disable ─────────────────────────────────────────────────────

  enable(name: string, reason = 'manual'): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    if (entry.enabled) return;

    entry.enabled      = true;
    entry.disabledAt   = undefined;
    entry.disableReason = undefined;

    this.logger.info(JSON.stringify({
      event: 'STRATEGY_ENABLED', strategy: name, reason,
    }));
  }

  disable(name: string, reason: string): void {
    const entry = this.entries.get(name);
    if (!entry) return;
    if (!entry.enabled) return;

    entry.enabled       = false;
    entry.disabledAt    = Date.now();
    entry.disableReason = reason;

    this.logger.warn(JSON.stringify({
      event:    'STRATEGY_DISABLED',
      strategy: name,
      reason,
      metrics:  entry.metrics,
    }));
  }

  // ─── Metric updates ───────────────────────────────────────────────────────

  /**
   * Called after every closed trade to update rolling metrics.
   * This is the single point where performance data flows into the registry.
   */
  recordTrade(
    strategyName: string,
    profit:       number,
    entryPrice:   number,
    exitPrice:    number,
  ): void {
    const entry = this.entries.get(strategyName);
    if (!entry) return;

    const rec: TradeRecord = {
      profit,
      timestamp:  Date.now(),
      win:        profit > 0,
      entryPrice,
      exitPrice,
    };

    // Append to window, trim to rolling size
    entry.tradeWindow.push(rec);
    if (entry.tradeWindow.length > this.cfg.rolling_window_size * 3) {
      entry.tradeWindow = entry.tradeWindow.slice(-this.cfg.rolling_window_size * 3);
    }

    // Recompute all metrics
    entry.metrics = this.computeMetrics(entry.tradeWindow, this.cfg.rolling_window_size);

    // Persist to DB
    this.saveMetrics(strategyName, entry.metrics);

    this.logger.debug(JSON.stringify({
      event:    'METRICS_UPDATED',
      strategy: strategyName,
      profit:   profit.toFixed(2),
      metrics:  entry.metrics,
    }));
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getAll(): Map<string, RegistryEntry> { return this.entries; }

  getActive(): RegistryEntry[] {
    return [...this.entries.values()].filter(e => e.enabled);
  }

  getDisabled(): Array<{ name: string; reason: string; disabledAt: number }> {
    return [...this.entries.entries()]
      .filter(([, e]) => !e.enabled)
      .map(([name, e]) => ({
        name,
        reason:     e.disableReason ?? 'unknown',
        disabledAt: e.disabledAt ?? 0,
      }));
  }

  getDefinition(name: string) { return this.entries.get(name)?.definition ?? null; }

  getMetrics(name: string): StrategyMetrics | null {
    return this.entries.get(name)?.metrics ?? null;
  }

  getSnapshot(): Record<string, { enabled: boolean; metrics: StrategyMetrics; definition?: RegistryEntry['definition'] }> {
    const snap: Record<string, { enabled: boolean; metrics: StrategyMetrics; definition?: RegistryEntry['definition'] }> = {};
    for (const [name, entry] of this.entries) {
      snap[name] = { enabled: entry.enabled, metrics: entry.metrics, definition: entry.definition };
    }
    return snap;
  }

  // ─── Metrics computation ──────────────────────────────────────────────────

  private computeMetrics(trades: TradeRecord[], rollingN: number): StrategyMetrics {
    if (trades.length === 0) return { ...EMPTY_METRICS };

    const wins       = trades.filter(t => t.win).length;
    const total      = trades.length;
    const profits    = trades.map(t => t.profit);
    const winRate    = wins / total;
    const expectancy = profits.reduce((s, p) => s + p, 0) / total;

    // Rolling window (last N trades)
    const rolling     = trades.slice(-rollingN);
    const rollingWins = rolling.filter(t => t.win).length;
    const rollingWR   = rolling.length ? rollingWins / rolling.length : 0.50;
    const rollingExp  = rolling.length
      ? rolling.reduce((s, t) => s + t.profit, 0) / rolling.length
      : 0;

    // Sharpe ratio (daily returns approximation)
    const sharpe  = this.computeSharpe(profits);

    // Max drawdown from equity curve
    const maxDD   = this.computeMaxDrawdown(profits);

    return {
      win_rate:            winRate,
      sharpe_ratio:        sharpe,
      max_drawdown:        maxDD,
      expectancy,
      rolling_win_rate:    rollingWR,
      rolling_expectancy:  rollingExp,
      total_trades:        total,
      rolling_trades:      rolling.length,
    };
  }

  private computeSharpe(trades: TradeRecord[]): number {
    if (trades.length < 5) return 0;

    // Build one PnL observation per UTC day. Sharpe on raw trade-by-trade
    // outcomes is not a time-series Sharpe and overstates statistical quality
    // when many trades occur on the same day.
    const byDay = new Map<string, number>();
    for (const trade of trades) {
      if (!Number.isFinite(trade.timestamp) || !Number.isFinite(trade.profit)) continue;
      const day = new Date(trade.timestamp).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + trade.profit);
    }

    const daily = Array.from(byDay.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, pnl]) => pnl);

    if (daily.length < 3) return 0;

    const mean = daily.reduce((sum, pnl) => sum + pnl, 0) / daily.length;
    const variance =
      daily.reduce((sum, pnl) => sum + Math.pow(pnl - mean, 2), 0) /
      daily.length;
    const std = Math.sqrt(variance);

    if (!(std > 0) || !Number.isFinite(std)) {
      return mean > 0 ? 0 : 0;
    }

    return (mean / std) * Math.sqrt(252);
  }

  private computeMaxDrawdown(trades: TradeRecord[]): number {
    if (!trades.length) return 0;

    const ordered = [...trades]
      .filter(
        trade =>
          Number.isFinite(trade.timestamp) &&
          Number.isFinite(trade.profit),
      )
      .sort((a, b) => a.timestamp - b.timestamp);

    let equity = this.initialEquity;
    let peak = this.initialEquity;
    let maxDD = 0;

    for (const trade of ordered) {
      equity += trade.profit;
      peak = Math.max(peak, equity);
      if (!(peak > 0)) continue;

      const dd = Math.max(0, (peak - equity) / peak);
      maxDD = Math.max(maxDD, dd);
    }

    return maxDD;
  }


  // ─── Persistence ──────────────────────────────────────────────────────────

  private saveMetrics(name: string, m: StrategyMetrics): void {
    try {
      this.db.raw().prepare(`
        INSERT OR REPLACE INTO strategy_metrics
          (name, win_rate, sharpe_ratio, max_drawdown, expectancy,
           rolling_win_rate, rolling_expectancy, total_trades, rolling_trades, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).run(
        name, m.win_rate, m.sharpe_ratio, m.max_drawdown, m.expectancy,
        m.rolling_win_rate, m.rolling_expectancy, m.total_trades,
        m.rolling_trades, Date.now(),
      );
    } catch { /* non-critical */ }
  }

  private loadMetrics(name: string): StrategyMetrics | null {
    try {
      const row = this.db.raw().prepare(
        `SELECT * FROM strategy_metrics WHERE name=?`
      ).get(name) as any;
      if (!row) return null;
      return {
        win_rate:           row.win_rate,
        sharpe_ratio:       row.sharpe_ratio,
        max_drawdown:       row.max_drawdown,
        expectancy:         row.expectancy,
        rolling_win_rate:   row.rolling_win_rate,
        rolling_expectancy: row.rolling_expectancy,
        total_trades:       row.total_trades,
        rolling_trades:     row.rolling_trades,
      };
    } catch { return null; }
  }
}
