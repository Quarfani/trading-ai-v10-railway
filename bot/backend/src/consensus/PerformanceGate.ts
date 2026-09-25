/**
 * PERFORMANCE GATE
 * ══════════════════════════════════════════════════════════════════════════
 * Automatically disables strategies that fail performance thresholds.
 * Re-enables them when metrics recover.
 *
 * Evaluation happens:
 *   1. Before each consensus round (called by ConsensusEngine)
 *   2. After every trade close (called by StrategyRegistry.recordTrade)
 *
 * Rules (ANY failure → disable):
 *   - win_rate < config.min_win_rate
 *   - sharpe_ratio < config.min_sharpe_ratio
 *   - rolling_expectancy <= config.min_rolling_expectancy
 *   - max_drawdown > config.max_drawdown
 *   - strategy has enough trades to be evaluated (min_trades_for_gate)
 *
 * Recovery: re-enable automatically when ALL metrics pass again.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { StrategyRegistry } from './StrategyRegistry';
import { ConsensusConfig }  from './types';
import { Logger }           from '../utils/Logger';

interface GateFailure {
  strategy:  string;
  failures:  string[];
  metrics:   Record<string, number>;
}

export class PerformanceGate {
  private readonly logger = new Logger('PerformanceGate');

  constructor(
    private readonly registry: StrategyRegistry,
    private readonly cfg:      ConsensusConfig,
  ) {}

  /**
   * Evaluate all registered strategies against performance thresholds.
   * Disable failing strategies; re-enable recovered ones.
   *
   * Returns a summary of gating decisions made this cycle.
   */
  evaluate(): {
    disabled: GateFailure[];
    reenabled: string[];
    skipped:  string[];  // too few trades — not yet evaluated
  } {
    const disabled:  GateFailure[] = [];
    const reenabled: string[]      = [];
    const skipped:   string[]      = [];

    for (const [name, entry] of this.registry.getAll()) {
      const m = entry.metrics;

      // Skip if not enough trades yet — don't penalise a new strategy
      if (m.total_trades < this.cfg.gate.min_trades_for_gate) {
        skipped.push(name);
        continue;
      }

      const failures = this.checkFailures(name, m);

      if (failures.length > 0) {
        if (entry.enabled) {
          const reason = failures.join(' | ');
          this.registry.disable(name, reason);
          disabled.push({
            strategy: name,
            failures,
            metrics: {
              win_rate:           m.win_rate,
              sharpe_ratio:       m.sharpe_ratio,
              rolling_expectancy: m.rolling_expectancy,
              max_drawdown:       m.max_drawdown,
            },
          });
          this.logger.warn(JSON.stringify({
            event:    'PERFORMANCE_GATE_FAILED',
            strategy: name,
            failures,
            metrics:  m,
          }));
        }
      } else {
        // All metrics pass — re-enable if it was disabled by the gate
        if (!entry.enabled && entry.disableReason?.includes('gate:')) {
          this.registry.enable(name, 'gate:recovery');
          reenabled.push(name);
          this.logger.info(JSON.stringify({
            event:    'STRATEGY_RECOVERED',
            strategy: name,
            metrics:  m,
          }));
        }
      }
    }

    return { disabled, reenabled, skipped };
  }

  // ─── Internal checks ──────────────────────────────────────────────────────

  private checkFailures(name: string, m: ReturnType<StrategyRegistry['getMetrics']> & {}): string[] {
    const g        = this.cfg.gate;
    const failures: string[] = [];

    if (m.win_rate < g.min_win_rate) {
      failures.push(
        `gate:win_rate=${m.win_rate.toFixed(3)} < ${g.min_win_rate}`
      );
    }

    if (m.sharpe_ratio < g.min_sharpe_ratio) {
      failures.push(
        `gate:sharpe=${m.sharpe_ratio.toFixed(3)} < ${g.min_sharpe_ratio}`
      );
    }

    if (m.rolling_expectancy <= g.min_rolling_expectancy) {
      failures.push(
        `gate:rolling_expectancy=${m.rolling_expectancy.toFixed(2)} <= ${g.min_rolling_expectancy}`
      );
    }

    if (m.max_drawdown > g.max_drawdown) {
      failures.push(
        `gate:max_drawdown=${(m.max_drawdown * 100).toFixed(1)}% > ${(g.max_drawdown * 100).toFixed(1)}%`
      );
    }

    return failures;
  }

  /**
   * Quick check: is this specific strategy currently passing all gates?
   * Used before allowing a strategy to vote.
   */
  passes(name: string): { ok: boolean; failures: string[] } {
    const entry = this.registry.getAll().get(name);
    if (!entry) return { ok: false, failures: ['not_registered'] };

    const m = entry.metrics;
    if (m.total_trades < this.cfg.gate.min_trades_for_gate) {
      return { ok: true, failures: [] }; // not enough data — allow by default
    }

    const failures = this.checkFailures(name, m);
    return { ok: failures.length === 0, failures };
  }
}
