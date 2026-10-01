/**
 * EVIDENCE SNAPSHOT STORE
 * Immutable audit records for research validation and parameter promotion.
 */
import { DatabaseManager } from "../database/DatabaseManager";

export interface EvidenceSnapshotRecord {
  scopeKey: string;
  strategyId?: string;
  strategyVersion?: string;
  symbol: string;
  timeframe: string;
  source: string;
  evidence: unknown;
  promoted?: boolean;
  promotionReason?: string;
  createdAt?: number;
}

export class EvidenceSnapshotStore {
  constructor(private readonly db: DatabaseManager) {}

  save(record: EvidenceSnapshotRecord): number {
    if (!record.scopeKey.trim()) throw new Error("[EvidenceSnapshot] scopeKey required");
    if (!record.symbol.trim()) throw new Error("[EvidenceSnapshot] symbol required");
    if (!record.timeframe.trim()) throw new Error("[EvidenceSnapshot] timeframe required");
    if (!record.source.trim()) throw new Error("[EvidenceSnapshot] source required");

    const result = this.db.raw().prepare(
      "INSERT INTO evidence_snapshots (scopeKey, strategyId, strategyVersion, symbol, timeframe, source, evidenceJson, promoted, promotionReason, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      record.scopeKey, record.strategyId ?? null, record.strategyVersion ?? null,
      record.symbol, record.timeframe, record.source, JSON.stringify(record.evidence),
      record.promoted ? 1 : 0, record.promotionReason ?? null, record.createdAt ?? Date.now(),
    );
    return Number(result.lastInsertRowid);
  }

  latest(scopeKey: string): EvidenceSnapshotRecord | null {
    const row = this.db.raw().prepare(
      "SELECT * FROM evidence_snapshots WHERE scopeKey=? ORDER BY createdAt DESC, id DESC LIMIT 1",
    ).get(scopeKey) as any;
    if (!row) return null;
    return {
      scopeKey: row.scopeKey, strategyId: row.strategyId ?? undefined, strategyVersion: row.strategyVersion ?? undefined,
      symbol: row.symbol, timeframe: row.timeframe, source: row.source,
      evidence: row.evidenceJson ? JSON.parse(row.evidenceJson) : undefined,
      promoted: row.promoted === 1, promotionReason: row.promotionReason ?? undefined, createdAt: row.createdAt,
    };
  }


  latestForStrategy(
    strategyId: string,
    symbol: string,
    timeframe: string,
  ): EvidenceSnapshotRecord | null {
    const row = this.db.raw().prepare(
      "SELECT * FROM evidence_snapshots WHERE strategyId=? AND symbol=? AND timeframe=? ORDER BY createdAt DESC, id DESC LIMIT 1",
    ).get(strategyId, symbol, timeframe) as any;

    if (!row) return null;

    return {
      scopeKey: row.scopeKey,
      strategyId: row.strategyId ?? undefined,
      strategyVersion: row.strategyVersion ?? undefined,
      symbol: row.symbol,
      timeframe: row.timeframe,
      source: row.source,
      evidence: row.evidenceJson ? JSON.parse(row.evidenceJson) : undefined,
      promoted: row.promoted === 1,
      promotionReason: row.promotionReason ?? undefined,
      createdAt: row.createdAt,
    };
  }

  recent(limit = 50): EvidenceSnapshotRecord[] {
    const rows = this.db.raw().prepare(
      "SELECT * FROM evidence_snapshots ORDER BY createdAt DESC, id DESC LIMIT ?",
    ).all(Math.max(1, Math.floor(limit))) as any[];
    return rows.map(row => ({
      scopeKey: row.scopeKey, strategyId: row.strategyId ?? undefined, strategyVersion: row.strategyVersion ?? undefined,
      symbol: row.symbol, timeframe: row.timeframe, source: row.source,
      evidence: row.evidenceJson ? JSON.parse(row.evidenceJson) : undefined,
      promoted: row.promoted === 1, promotionReason: row.promotionReason ?? undefined, createdAt: row.createdAt,
    }));
  }
}