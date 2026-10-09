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

  insertTrade(t: Trade & { account?: string; timeframe?: string; commission?: number; commissionCurrency?: string; entryQuoteToAccount?: number; exitQuoteToAccount?: number; mlPredictionId?: string }): number {
    const r = this.db.prepare(`
      INSERT INTO trades
        (ticket, symbol, timeframe, side, volume, entry, sl, tp,
         status, openedAt, source, account, commission, commissionCurrency, realizedProfit,
         entryQuoteToAccount, exitQuoteToAccount, mlPredictionId)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      t.ticket ?? null, t.symbol, t.timeframe ?? null,
      t.side, t.volume, t.entry, t.sl, t.tp,
      t.status, t.openedAt, t.source,
      t.account ?? 'default', t.commission ?? 0, t.commissionCurrency ?? null,
      t.realizedProfit ?? 0,
      t.entryQuoteToAccount ?? null, t.exitQuoteToAccount ?? null,
      t.mlPredictionId ?? null,
    );
    return Number(r.lastInsertRowid);
  }

  updateTradeClose(id: number, profit: number, closedAt: number, exitReason?: string, exitQuoteToAccount?: number) {
    const tx = this.db.transaction(() => {
      const r = this.db.prepare(
        `UPDATE trades SET status='closed', profit=?, closedAt=?, exitReason=?, exitQuoteToAccount=? WHERE id=? AND status='open'`
      ).run(profit, closedAt, exitReason ?? null, exitQuoteToAccount ?? null, id);
      if (r.changes !== 1) return false;

      const day = new Date(closedAt).toISOString().slice(0, 10);
      const win = profit > 0 ? 1 : 0;
      this.db.prepare(`
        INSERT INTO daily_stats(day, trades, wins, losses, pnl) VALUES (?,1,?,?,?)
        ON CONFLICT(day) DO UPDATE SET
          trades=trades+1, wins=wins+?, losses=losses+?, pnl=pnl+?
      `).run(day, win, 1-win, profit, win, 1-win, profit);
      return true;
    });
    return tx();
  }

  setNote(id: number, note: string) {
    this.db.prepare(`UPDATE trades SET notes=? WHERE id=?`).run(note, id);
  }

  getOpenTrades(): (Trade & { timeframe?: string })[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE status='open' ORDER BY openedAt DESC`
    ).all() as any[];
  }

  getRecentTrades(limit = 50): Trade[] {
    return this.db.prepare(
      `SELECT * FROM trades ORDER BY openedAt DESC LIMIT ?`
    ).all(limit) as Trade[];
  }

  getRecentClosedTrades(limit = 20): Trade[] {
    return this.db.prepare(
      `SELECT * FROM trades WHERE status='closed' ORDER BY closedAt DESC LIMIT ?`
    ).all(limit) as Trade[];
  }

  // ─── Signals ──────────────────────────────────────────────────────────────

  insertSignal(s: Signal) {
      this.db.prepare(`
        INSERT INTO signals(symbol, side, price, confidence, sl, tp, source, reason, timestamp)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(s.symbol, s.side, s.price, s.confidence, s.sl ?? null, s.tp ?? null,
             s.source, s.reason ?? null, s.timestamp);
  }

  getRecentSignals(limit = 50): Signal[] {
    return this.db.prepare(
      `SELECT * FROM signals ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as Signal[];
  }

  // ─── Audits — [FIX] corrected table name ──────────────────────────────────

  insertAudit(a: DecisionAudit) {
    this.db.prepare(`
        INSERT OR IGNORE INTO decision_audit
          (auditId,timestamp,symbol,side,decision,confidence,riskPassed,blockedBy)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        a.auditId, a.timestamp, a.symbol, a.side,
        a.decision, a.confidence, a.riskPassed ? 1 : 0, a.blockedBy ?? '',
      );
  }

  updateAudit(auditId: string, p: { executedOk?: boolean; riskPassed?: boolean; tradeId?: number }) {
      if (p.executedOk !== undefined)
        this.db.prepare(`UPDATE decision_audit SET executedOk=? WHERE auditId=?`).run(p.executedOk ? 1 : 0, auditId);
      if (p.riskPassed !== undefined)
        this.db.prepare(`UPDATE decision_audit SET riskPassed=? WHERE auditId=?`).run(p.riskPassed ? 1 : 0, auditId);
      if (p.tradeId !== undefined)
        this.db.prepare(`UPDATE decision_audit SET tradeId=? WHERE auditId=?`).run(p.tradeId, auditId);
  }

  getModelDecisionByPredictionId(predictionId: string): any | null {
    return this.db.prepare(
      `SELECT * FROM model_decisions WHERE predictionId=? ORDER BY timestamp DESC LIMIT 1`,
    ).get(predictionId) as any ?? null;
  }

  claimModelDecisionOutcome(
    predictionId: string,
    outcomeProfit: number,
    outcomeLabel: -1 | 0 | 1,
  ): { predictedLabel: -1 | 0 | 1 } | null {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT predictedLabel
         FROM model_decisions
         WHERE predictionId=?
           AND outcomeRecordedAt IS NULL
         ORDER BY timestamp DESC
         LIMIT 1`,
      ).get(predictionId) as { predictedLabel?: number | null } | undefined;

      if (
        !row ||
        row.predictedLabel == null ||
        ![-1, 0, 1].includes(Number(row.predictedLabel)) ||
        !Number.isFinite(outcomeProfit)
      ) {
        return null;
      }

      const changed = this.db.prepare(
        `UPDATE model_decisions
         SET outcomeLabel=?, outcomeProfit=?, outcomeRecordedAt=?
         WHERE predictionId=? AND outcomeRecordedAt IS NULL`,
      ).run(
        outcomeLabel,
        outcomeProfit,
        Date.now(),
        predictionId,
      ).changes;

      return changed === 1
        ? { predictedLabel: Number(row.predictedLabel) as -1 | 0 | 1 }
        : null;
    })();

    return tx;
  }

  getPendingModelOutcomes(limit = 100): any[] {
    if (!(limit > 0) || !Number.isFinite(limit)) return [];
    return this.db.prepare(
      `SELECT predictionId, symbol, timeframe, modelName, modelVersion,
              predictedLabel, outcomeLabel, outcomeProfit, outcomeRecordedAt
       FROM model_decisions
       WHERE predictionId IS NOT NULL
         AND outcomeRecordedAt IS NOT NULL
         AND outcomeSentAt IS NULL
       ORDER BY outcomeRecordedAt ASC
       LIMIT ?`,
    ).all(Math.floor(limit)) as any[];
  }

  getRecentModelOutcomes(
    limit = 500,
    since = 0,
  ): any[] {
    if (
      !(limit > 0) ||
      !Number.isFinite(limit) ||
      !Number.isFinite(since) ||
      since < 0
    ) {
      return [];
    }

    return this.db.prepare(
      `SELECT predictionId, symbol, timeframe, predictedLabel,
              outcomeLabel, outcomeProfit, outcomeRecordedAt
       FROM model_decisions
       WHERE predictionId IS NOT NULL
         AND outcomeRecordedAt IS NOT NULL
         AND outcomeRecordedAt >= ?
       ORDER BY outcomeRecordedAt DESC
       LIMIT ?`,
    ).all(
      since,
      Math.floor(limit),
    ) as any[];
  }

  markModelOutcomeSent(predictionId: string): boolean {
    return this.db.prepare(
      `UPDATE model_decisions
       SET outcomeSentAt=?
       WHERE predictionId=? AND outcomeRecordedAt IS NOT NULL
         AND outcomeSentAt IS NULL`,
    ).run(Date.now(), predictionId).changes === 1;
  }

  getRecentAudits(hours = 1): any[] {
    try {
      const since = Date.now() - hours * 3_600_000;
      return this.db.prepare(
        `SELECT * FROM decision_audit WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 200`
      ).all(since) as any[];
    } catch { return []; }
  }

  // ─── [NEW] Strategy Metrics persistence ───────────────────────────────────

  getStrategyMetrics(name: string): any | null {
    try {
      return this.db.prepare(`SELECT * FROM strategy_metrics WHERE name=?`).get(name) ?? null;
    } catch { return null; }
  }

  saveStrategyMetrics(name: string, m: Record<string, number>): void {
    try {
      this.db.prepare(`
        INSERT INTO strategy_metrics
          (name, win_rate, sharpe_ratio, max_drawdown, expectancy,
           rolling_win_rate, rolling_expectancy, total_trades, rolling_trades, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET
          win_rate=excluded.win_rate,
          sharpe_ratio=excluded.sharpe_ratio,
          max_drawdown=excluded.max_drawdown,
          expectancy=excluded.expectancy,
          rolling_win_rate=excluded.rolling_win_rate,
          rolling_expectancy=excluded.rolling_expectancy,
          total_trades=excluded.total_trades,
          rolling_trades=excluded.rolling_trades,
          updatedAt=excluded.updatedAt
      `).run(
        name,
        m.win_rate ?? 0.5, m.sharpe_ratio ?? 0, m.max_drawdown ?? 0,
        m.expectancy ?? 0, m.rolling_win_rate ?? 0.5, m.rolling_expectancy ?? 0,
        m.total_trades ?? 0, m.rolling_trades ?? 0, Date.now(),
      );
    } catch { /* non-critical */ }
  }

  // ─── [NEW] Consensus Log ──────────────────────────────────────────────────

  saveConsensusLog(entry: {
    symbol: string; outcome: string; block_reason: string;
    buy_weight?: number; sell_weight?: number; dominance?: number;
    active_strats?: number; voters?: number; duration_ms?: number;
    reasoning?: string; timestamp: number;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO consensus_log
          (symbol, outcome, block_reason, buy_weight, sell_weight,
           dominance, active_strats, voters, duration_ms, reasoning, timestamp)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        entry.symbol, entry.outcome, entry.block_reason,
        entry.buy_weight ?? null, entry.sell_weight ?? null,
        entry.dominance ?? null, entry.active_strats ?? null,
        entry.voters ?? null, entry.duration_ms ?? null,
        entry.reasoning ? JSON.stringify(entry.reasoning) : null,
        entry.timestamp,
      );
    } catch { /* non-critical */ }
  }

  // ─── Persistent execution ledger ────────────────────────────────────────

  createExecutionLedger(entry: {
    executionId: string; operationKey: string; action: string; status: string;
    symbol?: string; side?: string; volume?: number; signalId?: string; strategyId?: string;
    request?: Record<string, unknown>;
  }): boolean {
    if (!['PENDING', 'UNKNOWN', 'EXECUTED', 'FAILED'].includes(entry.status)) {
      return false;
    }
    const now = Date.now();
    const requestJson = entry.request ? JSON.stringify(entry.request) : null;
    const tradeId = entry.request?.tradeId != null &&
      Number.isFinite(Number(entry.request.tradeId))
      ? Number(entry.request.tradeId)
      : null;
    const result = this.db.prepare(`
      INSERT INTO execution_ledger
        (executionId,operationKey,action,status,symbol,side,volume,signalId,strategyId,tradeId,requestJson,createdAt,updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(operationKey) DO NOTHING
    `).run(
      entry.executionId, entry.operationKey, entry.action, entry.status,
      entry.symbol ?? null, entry.side ?? null, entry.volume ?? null,
      entry.signalId ?? null, entry.strategyId ?? null, tradeId,
      requestJson,
      now, now,
    );
    return result.changes === 1;
  }

  persistExecutedOpenTrade(
    trade: Trade & {
      account?: string;
      timeframe?: string;
      commission?: number;
      commissionCurrency?: string;
      entryQuoteToAccount?: number;
      exitQuoteToAccount?: number;
      mlPredictionId?: string;
    },
    executionId: string,
    brokerOrderId?: string | number,
    result?: unknown,
  ): number {
    const tx = this.db.transaction(() => {
      const inserted = this.db.prepare(`
        INSERT INTO trades
          (ticket, symbol, timeframe, side, volume, entry, sl, tp,
           status, openedAt, source, account, commission, commissionCurrency,
           realizedProfit, entryQuoteToAccount, exitQuoteToAccount, mlPredictionId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        trade.ticket ?? null,
        trade.symbol,
        trade.timeframe ?? null,
        trade.side,
        trade.volume,
        trade.entry,
        trade.sl,
        trade.tp,
        trade.status,
        trade.openedAt,
        trade.source,
        trade.account ?? 'default',
        trade.commission ?? 0,
        trade.commissionCurrency ?? null,
        trade.realizedProfit ?? 0,
        trade.entryQuoteToAccount ?? null,
        trade.exitQuoteToAccount ?? null,
        trade.mlPredictionId ?? null,
      );

      const localTradeId = Number(inserted.lastInsertRowid);
      const persistedResult =
        result === undefined
          ? undefined
          : (
              result &&
              typeof result === 'object' &&
              !Array.isArray(result)
                ? { ...(result as Record<string, unknown>), id: localTradeId }
                : result
            );

      const ledgerChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        brokerOrderId != null ? String(brokerOrderId) : null,
        persistedResult === undefined ? null : JSON.stringify(persistedResult),
        Date.now(),
        executionId,
      ).changes;

      if (ledgerChanged !== 1) {
        throw new Error(`Could not resolve executed OPEN ledger ${executionId}`);
      }

      return localTradeId;
    });

    return tx();
  }

  getLatestExecutedOpenOperationForTrade(tradeId: number): {
    executionId: string;
    operationKey: string;
    requestJson: string | null;
    resultJson: string | null;
    conflict?: boolean;
  } | null {
    const rows = this.db.prepare(`
      SELECT executionId, operationKey, requestJson, resultJson, tradeId
      FROM execution_ledger
      WHERE action='OPEN'
        AND status='EXECUTED'
        AND (tradeId=? OR tradeId IS NULL)
      ORDER BY updatedAt DESC, executionId DESC
      LIMIT 100
    `).all(tradeId) as Array<{
      executionId: string;
      operationKey: string;
      requestJson: string | null;
      resultJson: string | null;
      tradeId: number | null;
    }>;

    const matches = rows.filter(row => {
      if (Number(row.tradeId) === tradeId) return true;
      if (!row.requestJson) return false;
      try {
        return Number(JSON.parse(row.requestJson)?.tradeId) === tradeId;
      } catch {
        return false;
      }
    });

    const uniqueKeys = new Set(matches.map(row => row.operationKey));
    if (uniqueKeys.size > 1) {
      return {
        ...matches[0],
        conflict: true,
      };
    }

    return matches[0] ?? null;
  }

  getExecutionByOperationKey(operationKey: string): any | null {
    return this.db.prepare(`SELECT * FROM execution_ledger WHERE operationKey=?`).get(operationKey) ?? null;
  }

  getLatestUnresolvedExecutionForTrade(
    tradeId: number,
    actions?: string[],
  ): any | null {
    const actionFilter = actions?.length
      ? ` AND action IN (${actions.map(() => '?').join(',')})`
      : '';
    const indexed = this.db.prepare(`
      SELECT *
      FROM execution_ledger
      WHERE tradeId=?
        AND status IN ('PENDING','UNKNOWN')${actionFilter}
      ORDER BY updatedAt DESC, createdAt DESC
      LIMIT 1
    `).get(Number(tradeId), ...(actions ?? [])) as any | undefined;
    if (indexed) return indexed;

    // Backward-compatible fallback for pre-v15 rows that only stored tradeId
    // inside requestJson.
    const rows = this.db.prepare(`
      SELECT *
      FROM execution_ledger
      WHERE tradeId IS NULL
        AND status IN ('PENDING','UNKNOWN')${actionFilter}
      ORDER BY updatedAt DESC, createdAt DESC
    `).all(...(actions ?? [])) as any[];

    for (const row of rows) {
      if (!row.requestJson) continue;
      let request: any;
      try {
        request = JSON.parse(row.requestJson);
      } catch {
        continue;
      }
      if (Number(request?.tradeId) !== Number(tradeId)) continue;
      return row;
    }
    return null;
  }

  hasUnresolvedExecutionForTrade(tradeId: number, actions?: string[]): boolean {
    return this.findExecutionForTradeStatus(tradeId, ['PENDING', 'UNKNOWN'], actions) != null;
  }

  hasResolvedExecutionForTrade(tradeId: number, actions?: string[]): boolean {
    return this.findExecutionForTradeStatus(tradeId, ['EXECUTED'], actions) != null;
  }

  private findExecutionForTradeStatus(
    tradeId: number,
    statuses: string[],
    actions?: string[],
  ): any | null {
    const statusPlaceholders = statuses.map(() => '?').join(',');
    const actionFilter = actions?.length
      ? ` AND action IN (${actions.map(() => '?').join(',')})`
      : '';
    const indexed = this.db.prepare(`
      SELECT *
      FROM execution_ledger
      WHERE tradeId=?
        AND status IN (${statusPlaceholders})${actionFilter}
      ORDER BY updatedAt DESC, createdAt DESC
      LIMIT 1
    `).get(Number(tradeId), ...statuses, ...(actions ?? [])) as any | undefined;
    if (indexed) return indexed;

    const rows = this.db.prepare(`
      SELECT *
      FROM execution_ledger
      WHERE tradeId IS NULL
        AND status IN (${statusPlaceholders})${actionFilter}
      ORDER BY updatedAt DESC, createdAt DESC
    `).all(...statuses, ...(actions ?? [])) as any[];

    for (const row of rows) {
      if (!row.requestJson) continue;
      let request: any;
      try {
        request = JSON.parse(row.requestJson);
      } catch {
        continue;
      }
      if (Number(request?.tradeId) !== Number(tradeId)) continue;
      return row;
    }
    return null;
  }

  settleProtectionFailureClose(input: {
    parentExecutionId: string;
    parentOperationKey: string;
    parentBrokerOrderId: string | number;
    parentResult: unknown;
    childExecutionId: string;
    childOperationKey: string;
    childBrokerOrderId: string | number;
    childResult: unknown;
    exitProfitAccount: number;
    trade: Trade & {
      account?: string;
      timeframe?: string;
      commission?: number;
      commissionCurrency?: string;
      entryQuoteToAccount?: number;
      exitQuoteToAccount?: number;
      mlPredictionId?: string;
    };
  }): number | null {
    const t = input.trade;
    const entryFee = Number(t.commission ?? 0);
    const entryRealized = Number(t.realizedProfit ?? 0);
    const exitProfit = Number(input.exitProfitAccount);
    const finalProfit = Number(t.profit);
    const closedAt = Number(t.closedAt);
    const openedAt = Number(t.openedAt);
    const ticket = Number(t.ticket);
    if (
      !Number.isInteger(ticket) || ticket <= 0 ||
      !t.symbol || !['BUY', 'SELL'].includes(t.side) ||
      !(Number(t.volume) > 0) || !Number.isFinite(Number(t.volume)) ||
      !(Number(t.entry) > 0) || !Number.isFinite(Number(t.entry)) ||
      !Number.isFinite(Number(t.sl)) || !Number.isFinite(Number(t.tp)) ||
      !(openedAt > 0) || !Number.isFinite(openedAt) ||
      !(closedAt >= openedAt) || !Number.isFinite(closedAt) ||
      !Number.isFinite(entryFee) || entryFee < 0 ||
      !Number.isFinite(entryRealized) ||
      Math.abs(entryRealized + entryFee) > Math.max(1e-7, entryFee * 1e-9) ||
      !Number.isFinite(exitProfit) ||
      !Number.isFinite(finalProfit) ||
      Math.abs(finalProfit - (entryRealized + exitProfit)) > Math.max(1e-7, Math.abs(finalProfit) * 1e-9) ||
      t.status !== 'closed'
    ) {
      throw new Error('Invalid emergency-close settlement payload; no database changes were committed');
    }
    const tx = this.db.transaction(() => {
      const parent = this.db.prepare(
        'SELECT executionId, operationKey, action, status, requestJson FROM execution_ledger WHERE executionId=? LIMIT 1',
      ).get(input.parentExecutionId) as any;
      const child = this.db.prepare(
        'SELECT executionId, operationKey, action, status, requestJson FROM execution_ledger WHERE executionId=? LIMIT 1',
      ).get(input.childExecutionId) as any;
      if (
        !parent ||
        parent.executionId !== input.parentExecutionId ||
        parent.operationKey !== input.parentOperationKey ||
        parent.action !== 'OPEN' ||
        !['PENDING', 'UNKNOWN'].includes(String(parent.status)) ||
        !child ||
        child.executionId !== input.childExecutionId ||
        child.operationKey !== input.childOperationKey ||
        child.action !== 'PROTECTION_FAIL_CLOSE' ||
        !['PENDING', 'UNKNOWN'].includes(String(child.status))
      ) {
        return null;
      }

      let childRequest: any;
      let parentRequest: any;
      try {
        childRequest = JSON.parse(String(child.requestJson ?? 'null'));
        parentRequest = JSON.parse(String(parent.requestJson ?? 'null'));
      } catch {
        return null;
      }
      if (
        !childRequest ||
        String(childRequest.parentOperationKey ?? '') !== input.parentOperationKey ||
        !parentRequest ||
        String(parentRequest.signal?.symbol ?? '').toUpperCase() !== String(t.symbol).toUpperCase() ||
        String(parentRequest.signal?.side ?? '').toUpperCase() !== String(t.side).toUpperCase()
      ) {
        return null;
      }

      const duplicate = this.db.prepare(
        'SELECT id, status FROM trades WHERE ticket=? AND symbol=? LIMIT 1',
      ).get(ticket, t.symbol) as { id: number; status: string } | undefined;
      if (duplicate) return null;

      const inserted = this.db.prepare(`
        INSERT INTO trades
          (ticket, symbol, timeframe, side, volume, entry, sl, tp,
           status, openedAt, closedAt, profit, source, account, commission,
           commissionCurrency, realizedProfit, exitReason, entryQuoteToAccount,
           exitQuoteToAccount, mlPredictionId)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        ticket,
        t.symbol,
        t.timeframe ?? null,
        t.side,
        t.volume,
        t.entry,
        t.sl,
        t.tp,
        'closed',
        openedAt,
        closedAt,
        finalProfit,
        t.source ?? '',
        t.account ?? 'default',
        entryFee,
        t.commissionCurrency ?? null,
        entryRealized,
        t.exitReason ?? 'PROTECTION_FAILURE',
        t.entryQuoteToAccount ?? null,
        t.exitQuoteToAccount ?? null,
        t.mlPredictionId ?? null,
      );
      const tradeId = Number(inserted.lastInsertRowid);

      const parentResult = {
        ...(input.parentResult && typeof input.parentResult === 'object' && !Array.isArray(input.parentResult)
          ? input.parentResult as Record<string, unknown>
          : { evidence: input.parentResult }),
        id: tradeId,
        status: 'closed',
        emergencyProtectionFailure: true,
        netProfit: finalProfit,
        childOperationKey: input.childOperationKey,
      };
      const childResult = {
        ...(input.childResult && typeof input.childResult === 'object' && !Array.isArray(input.childResult)
          ? input.childResult as Record<string, unknown>
          : { evidence: input.childResult }),
        tradeId,
        parentExecutionId: input.parentExecutionId,
        parentOperationKey: input.parentOperationKey,
        exitProfitAccount: exitProfit,
        netProfit: finalProfit,
        atomicSettlement: true,
      };

      const parentChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', tradeId=?, brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        tradeId,
        String(input.parentBrokerOrderId),
        JSON.stringify(parentResult),
        Date.now(),
        input.parentExecutionId,
      ).changes;
      if (parentChanged !== 1) {
        throw new Error('Could not atomically resolve parent OPEN ledger for emergency close');
      }

      const childChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', tradeId=?, brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        tradeId,
        String(input.childBrokerOrderId),
        JSON.stringify(childResult),
        Date.now(),
        input.childExecutionId,
      ).changes;
      if (childChanged !== 1) {
        throw new Error('Could not atomically resolve emergency-close child ledger');
      }

      if (t.mlPredictionId && t.mlPredictionId.trim()) {
        const actualLabel: -1 | 0 | 1 =
          finalProfit > 0
            ? (t.side === 'BUY' ? 1 : -1)
            : finalProfit < 0
              ? (t.side === 'BUY' ? -1 : 1)
              : 0;
        this.db.prepare(`
          UPDATE model_decisions
          SET outcomeLabel=?, outcomeProfit=?, outcomeRecordedAt=?
          WHERE predictionId=?
            AND outcomeRecordedAt IS NULL
            AND predictedLabel IN (-1,0,1)
        `).run(actualLabel, finalProfit, Date.now(), t.mlPredictionId.trim());
      }

      const day = new Date(closedAt).toISOString().slice(0, 10);
      const win = finalProfit > 0 ? 1 : 0;
      this.db.prepare(`
        INSERT INTO daily_stats(day, trades, wins, losses, pnl)
        VALUES (?,?,?,?,?)
        ON CONFLICT(day) DO UPDATE SET
          trades=daily_stats.trades + excluded.trades,
          wins=daily_stats.wins + excluded.wins,
          losses=daily_stats.losses + excluded.losses,
          pnl=daily_stats.pnl + excluded.pnl
      `).run(day, 1, win, 1 - win, finalProfit);

      return tradeId;
    });
    return tx();
  }

  resolveReconciledFullClose(
    tradeId: number,
    executionId: string,
    profit: number,
    closedAt: number,
    exitReason: string,
    result: unknown,
    brokerOrderId?: string | number,
  ): boolean {
    const resultObject = result && typeof result === 'object'
      ? result as { quoteToAccount?: unknown; exitQuoteToAccount?: unknown }
      : null;
    const rawExitQuoteToAccount =
      resultObject?.exitQuoteToAccount ?? resultObject?.quoteToAccount;
    const exitQuoteToAccount = rawExitQuoteToAccount == null
      ? null
      : Number(rawExitQuoteToAccount);
    if (
      exitQuoteToAccount != null &&
      (!(exitQuoteToAccount > 0) || !Number.isFinite(exitQuoteToAccount))
    ) {
      throw new Error(`Invalid exit quote conversion for reconciled full-close trade id=${tradeId}`);
    }

    const tx = this.db.transaction(() => {
      const trade = this.db.prepare(
        `SELECT status, side, realizedProfit, mlPredictionId FROM trades WHERE id=? LIMIT 1`,
      ).get(tradeId) as {
        status: string;
        side: 'BUY' | 'SELL';
        realizedProfit?: number | null;
        mlPredictionId?: string | null;
      } | undefined;
      if (!trade) return false;

      const ledger = this.db.prepare(
        `SELECT status FROM execution_ledger WHERE executionId=? LIMIT 1`,
      ).get(executionId) as { status: string } | undefined;
      if (!ledger || !['PENDING', 'UNKNOWN'].includes(ledger.status)) return false;
      if (trade.status !== 'open') return false;

      if (trade.status === 'open') {
        if (!Number.isFinite(profit) || !Number.isFinite(Number(trade.realizedProfit ?? 0))) {
          throw new Error(`Invalid PnL for reconciled full-close trade id=${tradeId}`);
        }

        const cumulativeProfit = Number(trade.realizedProfit ?? 0) + Number(profit);
        if (!Number.isFinite(cumulativeProfit)) {
          throw new Error(`Cumulative PnL overflow for reconciled full-close trade id=${tradeId}`);
        }

        const changed = this.db.prepare(
          `UPDATE trades
           SET status='closed', profit=?, closedAt=?, exitReason=?,
               exitQuoteToAccount=COALESCE(?, exitQuoteToAccount)
           WHERE id=? AND status='open'`,
        ).run(cumulativeProfit, closedAt, exitReason, exitQuoteToAccount, tradeId).changes;
        if (changed !== 1) {
          throw new Error(`Could not persist reconciled full-close trade id=${tradeId}`);
        }

        if (trade.mlPredictionId && trade.mlPredictionId.trim()) {
          const actualLabel: -1 | 0 | 1 =
            cumulativeProfit > 0
              ? (trade.side === 'BUY' ? 1 : -1)
              : cumulativeProfit < 0
                ? (trade.side === 'BUY' ? -1 : 1)
                : 0;

          this.db.prepare(
            `UPDATE model_decisions
             SET outcomeLabel=?, outcomeProfit=?, outcomeRecordedAt=?
             WHERE predictionId=?
               AND outcomeRecordedAt IS NULL
               AND predictedLabel IN (-1,0,1)`,
          ).run(
            actualLabel,
            cumulativeProfit,
            Date.now(),
            trade.mlPredictionId.trim(),
          );
        }

        const day = new Date(closedAt).toISOString().slice(0, 10);
        const win = cumulativeProfit > 0 ? 1 : 0;
        this.db.prepare(`
          INSERT INTO daily_stats(day, trades, wins, losses, pnl)
          VALUES (?,?,?,?,?)
          ON CONFLICT(day) DO UPDATE SET
            trades=daily_stats.trades + excluded.trades,
            wins=daily_stats.wins + excluded.wins,
            losses=daily_stats.losses + excluded.losses,
            pnl=daily_stats.pnl + excluded.pnl
        `).run(day, 1, win, 1 - win, cumulativeProfit);
      }

      const ledgerChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        brokerOrderId != null ? String(brokerOrderId) : null,
        JSON.stringify(result),
        Date.now(),
        executionId,
      ).changes;
      if (ledgerChanged !== 1) {
        throw new Error(`Could not resolve reconciled full ledger ${executionId}`);
      }
      return true;
    });

    return tx();
  }

  resolveReconciledPartialClose(
    tradeId: number,
    executionId: string,
    volume: number,
    realizedProfit: number,
    result: unknown,
    brokerOrderId?: string | number,
  ): boolean {
    const tx = this.db.transaction(() => {
      const trade = this.db.prepare(
        `SELECT status FROM trades WHERE id=? LIMIT 1`,
      ).get(tradeId) as { status: string } | undefined;
      if (!trade || trade.status !== 'open') return false;

      const ledger = this.db.prepare(
        `SELECT status FROM execution_ledger WHERE executionId=? LIMIT 1`,
      ).get(executionId) as { status: string } | undefined;
      if (!ledger || !['PENDING', 'UNKNOWN'].includes(ledger.status)) return false;

      const tradeChanged = this.db.prepare(
        `UPDATE trades
         SET volume=?, realizedProfit=?
         WHERE id=? AND status='open'`,
      ).run(volume, realizedProfit, tradeId).changes;
      if (tradeChanged !== 1) {
        throw new Error(`Could not persist reconciled partial trade id=${tradeId}`);
      }

      const ledgerChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        brokerOrderId != null ? String(brokerOrderId) : null,
        JSON.stringify(result),
        Date.now(),
        executionId,
      ).changes;
      if (ledgerChanged !== 1) {
        throw new Error(`Could not resolve reconciled partial ledger ${executionId}`);
      }
      return true;
    });

    return tx();
  }

  resolveReconciledSLTP(
    tradeId: number,
    executionId: string,
    newSl: number,
    newTp: number,
    result: unknown,
    brokerOrderId?: string | number,
  ): boolean {
    const tx = this.db.transaction(() => {
      const trade = this.db.prepare(
        `SELECT status FROM trades WHERE id=? LIMIT 1`,
      ).get(tradeId) as { status: string } | undefined;
      if (!trade || trade.status !== 'open') return false;

      const ledger = this.db.prepare(
        `SELECT status FROM execution_ledger WHERE executionId=? LIMIT 1`,
      ).get(executionId) as { status: string } | undefined;
      if (!ledger || !['PENDING', 'UNKNOWN'].includes(ledger.status)) return false;

      const tradeChanged = this.db.prepare(
        `UPDATE trades
         SET sl=?, tp=?
         WHERE id=? AND status='open'`,
      ).run(newSl, newTp, tradeId).changes;
      if (tradeChanged !== 1) {
        throw new Error(`Could not persist reconciled SLTP trade id=${tradeId}`);
      }

      const ledgerChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        brokerOrderId != null ? String(brokerOrderId) : null,
        JSON.stringify(result),
        Date.now(),
        executionId,
      ).changes;
      if (ledgerChanged !== 1) {
        throw new Error(`Could not resolve reconciled SLTP ledger ${executionId}`);
      }
      return true;
    });

    return tx();
  }

  resolveExecutionLedger(
    executionId: string,
    result?: unknown,
    brokerOrderId?: string | number,
  ): boolean {
    const fields = [
      'status=\'EXECUTED\'',
      'updatedAt=?',
    ];
    const values: unknown[] = [Date.now()];
    if (result !== undefined) {
      fields.push('resultJson=?');
      values.push(JSON.stringify(result));
    }
    if (brokerOrderId !== undefined) {
      fields.push('brokerOrderId=?');
      values.push(String(brokerOrderId));
    }
    fields.push('error=NULL');
    values.push(executionId);

    const changed = this.db.prepare(`
      UPDATE execution_ledger
      SET ${fields.join(', ')}
      WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
    `).run(...values).changes;
    return changed === 1;
  }

  updateExecutionRequest(
    executionId: string,
    request: Record<string, unknown>,
  ): boolean {
    const serialized = JSON.stringify(request);
    if (!serialized) return false;
    const changed = this.db.prepare(`
      UPDATE execution_ledger
      SET requestJson=?, updatedAt=?
      WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
    `).run(serialized, Date.now(), executionId).changes;
    return changed === 1;
  }

  updateExecutionLedger(executionId: string, patch: {
    status?: string; brokerOrderId?: string | number; retryCount?: number;
    result?: unknown; error?: string | null;
  }): boolean {
    const current = this.db.prepare(
      `SELECT status FROM execution_ledger WHERE executionId=? LIMIT 1`,
    ).get(executionId) as { status: string } | undefined;
    if (!current) return false;

    // Execution states are intentionally one-way. Terminal records are
    // immutable so a late callback cannot rewrite broker truth.
    if (current.status === 'EXECUTED' || current.status === 'FAILED') {
      return false;
    }

    const requested = patch.status;
    if (requested !== undefined) {
      const legal =
        (current.status === 'PENDING' &&
          (requested === 'UNKNOWN' || requested === 'EXECUTED' || requested === 'FAILED')) ||
        (current.status === 'UNKNOWN' &&
          (requested === 'UNKNOWN' || requested === 'EXECUTED' || requested === 'FAILED'));
      if (!legal) return false;
    }

    const fields: string[] = ['updatedAt=?'];
    const values: unknown[] = [Date.now()];
    if (patch.status !== undefined) { fields.push('status=?'); values.push(patch.status); }
    if (patch.brokerOrderId !== undefined) { fields.push('brokerOrderId=?'); values.push(String(patch.brokerOrderId)); }
    if (patch.retryCount !== undefined) { fields.push('retryCount=?'); values.push(patch.retryCount); }
    if (patch.result !== undefined) { fields.push('resultJson=?'); values.push(JSON.stringify(patch.result)); }
    if (patch.error !== undefined) { fields.push('error=?'); values.push(patch.error); }
    values.push(executionId);
    const changed = this.db.prepare(
      `UPDATE execution_ledger SET ${fields.join(', ')} WHERE executionId=? AND status IN ('PENDING','UNKNOWN')`,
    ).run(...values).changes;
    return changed === 1;
  }

  saveExecutionEvent(entry: {
    executionId: string; brokerOrderId?: string | number; operationKey: string;
    symbol: string; side?: string; action: string; quantity?: number; price?: number;
    status: string; latencyMs?: number; retryCount?: number; error?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO executions
        (executionId,brokerOrderId,operationKey,symbol,side,action,quantity,price,status,latencyMs,retryCount,error,timestamp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      entry.executionId, entry.brokerOrderId == null ? null : String(entry.brokerOrderId),
      entry.operationKey, entry.symbol, entry.side ?? null, entry.action,
      entry.quantity ?? null, entry.price ?? null, entry.status,
      entry.latencyMs ?? null, entry.retryCount ?? 0, entry.error ?? null, Date.now(),
    );
  }

  recordSystemEvent(event: string, severity: string, payload?: unknown) {
    this.db.prepare(`INSERT INTO system_events(event,severity,payload,timestamp) VALUES (?,?,?,?)`)
      .run(event, severity, payload == null ? null : JSON.stringify(payload), Date.now());
  }

  // ─── Stats ────────────────────────────────────────────────────────────────

  getTodayStats() {
    const day = new Date().toISOString().slice(0, 10);
    return this.db.prepare(`SELECT * FROM daily_stats WHERE day=?`).get(day) as any ?? null;
  }

  getOpenPartialRealizedPnlSince(since: number): number {
    if (!Number.isFinite(since)) return 0;
    const rows = this.db.prepare(`
      SELECT requestJson, resultJson
      FROM execution_ledger
      WHERE action='PARTIAL_CLOSE'
        AND status='EXECUTED'
        AND updatedAt > ?
      ORDER BY updatedAt ASC
    `).all(since) as Array<{ requestJson?: string | null; resultJson?: string | null }>;

    let total = 0;
    for (const row of rows) {
      if (!row.requestJson || !row.resultJson) continue;
      let request: any;
      let result: any;
      try {
        request = JSON.parse(row.requestJson);
        result = JSON.parse(row.resultJson);
      } catch {
        continue;
      }
      const tradeId = Number(request?.tradeId);
      if (!Number.isInteger(tradeId) || tradeId <= 0) continue;
      const trade = this.db.prepare(
        `SELECT status FROM trades WHERE id=? LIMIT 1`,
      ).get(tradeId) as { status: string } | undefined;
      if (!trade || trade.status !== 'open') continue;
      const profit = Number(result?.profit);
      if (Number.isFinite(profit)) total += profit;
    }
    return Number.isFinite(total) ? total : 0;
  }
  getWeeklyStats() {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    return this.db.prepare(`
      SELECT SUM(trades) trades, SUM(wins) wins, SUM(losses) losses, SUM(pnl) pnl
      FROM daily_stats WHERE day >= ?
    `).get(since.toISOString().slice(0, 10)) as any ?? { trades:0, wins:0, losses:0, pnl:0 };
  }

  getAccountSnapshots(limit = 100): any[] {
    return this.db.prepare(`
      SELECT * FROM account_snapshots ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as any[];
  }

  saveAccountSnapshot(equity: number, balance: number): void {
    try {
      this.db.prepare(`
        INSERT INTO account_snapshots(equity, balance, timestamp) VALUES (?,?,?)
      `).run(equity, balance, Date.now());
    } catch { /* non-critical */ }
  }

  // ─── Settings ─────────────────────────────────────────────────────────────

  getSetting(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM settings WHERE key=?`).get(key) as any;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings(key, value) VALUES (?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, value);
  }
}
