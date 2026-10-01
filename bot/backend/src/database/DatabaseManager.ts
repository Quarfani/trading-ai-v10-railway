/**
 * DATABASE MANAGER — v7.1
 * [FIX] decision_audits → decision_audit (كانت المايغريشن تُنشئ decision_audit بدون 's')
 * [NEW] getStrategyMetrics() و saveStrategyMetrics() للـ StrategyRegistry
 * [NEW] saveConsensusLog() للـ ConsensusLogger
 */
import Database from 'better-sqlite3';
import * as fs   from 'fs';
import * as path from 'path';
import { Trade, Signal, DecisionAudit } from '../types/trading.types';
import { runMigrations }                from './migrations';

export class DatabaseManager {
  private db!: Database.Database;
  constructor(private dbPath: string) {}

  async initialize() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Financial ledger: prefer durability over a small write-latency gain.
    this.db.pragma('synchronous = FULL');
    this.db.pragma('cache_size = -32000'); // 32MB cache
    runMigrations(this.db);
  }

  raw(): Database.Database { return this.db; }
  get path(): string { return this.dbPath; }

  // ─── Trades ───────────────────────────────────────────────────────────────

  insertTrade(t: Trade & { account?: string; timeframe?: string; commission?: number; entryQuoteToAccount?: number; exitQuoteToAccount?: number }): number {
    const r = this.db.prepare(`
      INSERT INTO trades
        (ticket, symbol, timeframe, side, volume, entry, sl, tp,
         status, openedAt, source, account, commission, realizedProfit,
         entryQuoteToAccount, exitQuoteToAccount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      t.ticket ?? null, t.symbol, t.timeframe ?? null,
      t.side, t.volume, t.entry, t.sl, t.tp,
      t.status, t.openedAt, t.source,
      t.account ?? 'default', t.commission ?? 0, t.realizedProfit ?? 0,
      t.entryQuoteToAccount ?? null, t.exitQuoteToAccount ?? null,
    );
    return Number(r.lastInsertRowid);
  }