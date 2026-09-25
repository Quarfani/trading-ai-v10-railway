/**
 * CONSENSUS LOGGER
 * ══════════════════════════════════════════════════════════════════════════
 * Structured, machine-readable logging for the consensus engine.
 * Persists every decision to the consensus_log table for audit trail.
 *
 * Log events emitted:
 *   STRATEGY_DISABLED      — gate auto-disabled a strategy
 *   STRATEGY_RECOVERED     — gate re-enabled a strategy
 *   CONFLICT_BLOCKED       — BUY vs SELL conflict detected
 *   CONSENSUS_APPROVED     — trade approved with full weight details
 *   NO_TRADE_*             — various no-trade reasons
 *   PERFORMANCE_DEGRADATION — metric dropped significantly
 * ══════════════════════════════════════════════════════════════════════════
 */
import { ConsensusResult }  from './types';
import { DatabaseManager }  from '../database/DatabaseManager';
import { Logger }           from '../utils/Logger';

export class ConsensusLogger {
  private readonly logger = new Logger('ConsensusLog');

  constructor(private readonly db: DatabaseManager) {}

  /**
   * Log and persist a completed consensus result.
   */
  log(result: ConsensusResult): void {
    const voters = result.votes.filter(v => v.vote !== 'NONE').length;

    // Structured console log
    const entry = {
      event:         result.block_reason === 'APPROVED' ? 'CONSENSUS_APPROVED' : `NO_TRADE_${result.block_reason}`,
      outcome:       result.outcome,
      block_reason:  result.block_reason,
      buy_weight:    +result.total_buy_weight.toFixed(6),
      sell_weight:   +result.total_sell_weight.toFixed(6),
      dominance:     +result.dominance_ratio.toFixed(4),
      active_strats: result.active_strategies,
      voters,
      disabled:      result.disabled_strategies.map(d => d.name),
      duration_ms:   result.duration_ms,
      timestamp:     result.timestamp,
    };

    if (result.block_reason === 'APPROVED') {
      this.logger.info(JSON.stringify(entry));
    } else if (result.block_reason === 'CONFLICT_BLOCKED') {
      this.logger.warn(JSON.stringify(entry));
    } else {
      this.logger.debug(JSON.stringify(entry));
    }

    // Persist to DB
    this.persist(result, voters);
  }

  /**
   * Log a performance degradation event when a metric drops significantly
   * compared to a previous snapshot.
   */
  logDegradation(strategy: string, metric: string, previous: number, current: number): void {
    this.logger.warn(JSON.stringify({
      event:    'PERFORMANCE_DEGRADATION',
      strategy,
      metric,
      previous: +previous.toFixed(4),
      current:  +current.toFixed(4),
      drop_pct: +(((previous - current) / (Math.abs(previous) + 0.0001)) * 100).toFixed(1),
    }));
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private persist(result: ConsensusResult, voters: number): void {
    try {
      this.db.raw().prepare(`
        INSERT INTO consensus_log
          (symbol, outcome, block_reason, buy_weight, sell_weight,
           dominance, active_strats, voters, duration_ms, reasoning, timestamp)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        result.signal?.symbol ?? 'UNKNOWN',
        result.outcome,
        result.block_reason,
        result.total_buy_weight,
        result.total_sell_weight,
        result.dominance_ratio,
        result.active_strategies,
        voters,
        result.duration_ms,
        result.reasoning.slice(-20).join('\n'), // last 20 lines
        result.timestamp,
      );
    } catch { /* non-critical */ }
  }

  /**
   * Query recent consensus decisions (for API/dashboard).
   */
  recent(limit = 50): any[] {
    try {
      return this.db.raw().prepare(
        `SELECT * FROM consensus_log ORDER BY timestamp DESC LIMIT ?`
      ).all(limit) as any[];
    } catch { return []; }
  }

  /**
   * Conflict rate in the last N hours.
   */
  conflictRate(hours = 24): { total: number; conflicts: number; rate: number } {
    try {
      const since = Date.now() - hours * 3_600_000;
      const row = this.db.raw().prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN block_reason='CONFLICT_BLOCKED' THEN 1 ELSE 0 END) as conflicts
        FROM consensus_log WHERE timestamp >= ?
      `).get(since) as { total: number; conflicts: number };
      const rate = row.total > 0 ? row.conflicts / row.total : 0;
      return { total: row.total, conflicts: row.conflicts, rate };
    } catch { return { total: 0, conflicts: 0, rate: 0 }; }
  }
}
