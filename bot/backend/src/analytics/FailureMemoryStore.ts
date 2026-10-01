/**
 * FAILURE MEMORY STORE
 *
 * Persists structured loss root causes and counterfactual analysis.
 * It is analytics-only: it never changes an open position.
 */
import { DatabaseManager } from '../database/DatabaseManager';

export interface FailureMemoryRecord {
  tradeId?: number;
  symbol: string;
  timeframe?: string;
  strategy?: string;
  regime?: string;
  side?: string;
  entryPrice?: number;
  exitPrice?: number;
  spread?: number;
  slippage?: number;
  volatility?: number;
  newsContext?: string;
  correlationContext?: string;
  size?: number;
  profit: number;
  rootCause: string;
  counterfactual?: unknown;
  createdAt?: number;
}

export class FailureMemoryStore {
  constructor(private readonly db: DatabaseManager) {}

  record(record: FailureMemoryRecord): void {
    if (!record.symbol.trim()) throw new Error('[FailureMemory] symbol required');
    if (!Number.isFinite(record.profit)) throw new Error('[FailureMemory] profit must be finite');
    if (!record.rootCause.trim()) throw new Error('[FailureMemory] rootCause required');

    this.db.raw().prepare(`
      INSERT INTO failure_memory (
        tradeId, symbol, timeframe, strategy, regime, side,
        entryPrice, exitPrice, spread, slippage, volatility,
        newsContext, correlationContext, size, profit,
        rootCause, counterfactualJson, createdAt
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      )
    `).run(
      record.tradeId ?? null,
      record.symbol,
      record.timeframe ?? null,
      record.strategy ?? null,
      record.regime ?? null,
      record.side ?? null,
      record.entryPrice ?? null,
      record.exitPrice ?? null,
      record.spread ?? null,
      record.slippage ?? null,
      record.volatility ?? null,
      record.newsContext ?? null,
      record.correlationContext ?? null,
      record.size ?? null,
      record.profit,
      record.rootCause,
      record.counterfactual == null ? null : JSON.stringify(record.counterfactual),
      record.createdAt ?? Date.now(),
    );
  }

  recent(limit = 50): FailureMemoryRecord[] {
    const rows = this.db.raw().prepare(`
      SELECT *
      FROM failure_memory
      ORDER BY createdAt DESC, id DESC
      LIMIT ?
    `).all(Math.max(1, Math.floor(limit))) as any[];

    return rows.map(row => ({
      tradeId: row.tradeId ?? undefined,
      symbol: row.symbol,
      timeframe: row.timeframe ?? undefined,
      strategy: row.strategy ?? undefined,
      regime: row.regime ?? undefined,
      side: row.side ?? undefined,
      entryPrice: row.entryPrice ?? undefined,
      exitPrice: row.exitPrice ?? undefined,
      spread: row.spread ?? undefined,
      slippage: row.slippage ?? undefined,
      volatility: row.volatility ?? undefined,
      newsContext: row.newsContext ?? undefined,
      correlationContext: row.correlationContext ?? undefined,
      size: row.size ?? undefined,
      profit: row.profit,
      rootCause: row.rootCause,
      counterfactual: row.counterfactualJson
        ? JSON.parse(row.counterfactualJson)
        : undefined,
      createdAt: row.createdAt,
    }));
  }
}
