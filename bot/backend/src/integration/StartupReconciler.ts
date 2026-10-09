import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { BinanceExecutor } from '../execution/BinanceExecutor';
import { TelegramBot } from '../notifications/TelegramBot';
import { Logger } from '../utils/Logger';
import { MarketScanner } from '../core/MarketScanner';
import { CurrencyConversionProvider } from '../market/CurrencyConversionProvider';
import { resolveHistoricalQuoteToAccount } from '../market/HistoricalCurrencySeries';
import { loadHistoricalCurrencySeries } from '../market/HistoricalCurrencySeriesLoader';
import { getSymbolSpec } from '../config/symbolConfig';
import { isTimeframe } from '../market/market.types';

/**
 * Startup reconciliation is a trading gate, not a best-effort diagnostic.
 * Any broker/internal ambiguity throws and prevents the engine from starting.
 */
export class StartupReconciler {
  private logger = new Logger('StartupReconciler');

  constructor(private config: SystemConfig, private db: DatabaseManager, private telegram: TelegramBot) {}

  async run(): Promise<void> {
    if (this.config.mode === 'paper') {
      this.assertNoUnresolvedLedger();
      this.assertInternalPaperState();
      this.record('OK', null, { mode: 'paper' }, 'Paper state is internally consistent');
      return;
    }

    try {
      let brokerSnapshot: unknown;
      if (this.config.mode === 'mt5') brokerSnapshot = await this.reconcileMT5();
      else brokerSnapshot = await this.reconcileBinance();
      this.assertNoUnresolvedLedger();
      this.record('OK', null, brokerSnapshot, 'Startup reconciliation passed');
      this.logger.info('Startup reconciliation passed');
    } catch (e: any) {
      const message = e?.message ?? String(e);
      this.record('BLOCKED', null, null, message);
      await this.telegram.sendMessage(`🚨 <b>STARTUP RECONCILIATION BLOCKED</b>\n${message}`).catch(() => {});
      throw new Error(`[Reconciliation] BLOCKED: ${message}`);
    }
  }

  private assertNoUnresolvedLedger() {
    const unresolved = this.db.raw().prepare(
      `SELECT COUNT(*) c FROM execution_ledger WHERE status IN ('PENDING','UNKNOWN')`,
    ).get() as { c: number };
    if (unresolved.c > 0) {
      throw new Error(
        `[Reconciliation] ${unresolved.c} unresolved execution ledger entries block startup`,
      );
    }
  }

  private async resolveAuthoritativeMT5CloseLedgers(): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, action, requestJson, createdAt
      FROM execution_ledger
      WHERE status IN ('PENDING','UNKNOWN')
        AND action IN ('CLOSE','CLOSE_AT_MARKET')
      ORDER BY updatedAt ASC, createdAt ASC, executionId ASC
    `).all() as Array<{
      executionId: string;
      action: string;
      requestJson?: string | null;
      createdAt: number;
    }>;

    const selectedExecutionByTrade = new Map<number, string>();
    for (const row of rows) {
      if (!row.requestJson) continue;
      try {
        const request = JSON.parse(row.requestJson);
        const tradeId = Number(request?.tradeId);
        if (Number.isInteger(tradeId) && tradeId > 0 && !selectedExecutionByTrade.has(tradeId)) {
          selectedExecutionByTrade.set(tradeId, String(row.executionId));
        }
      } catch {
        // malformed requestJson remains unresolved and blocks startup
      }
    }

    for (const row of rows) {
      if (!row.requestJson) continue;

      let request: any;
      try {
        request = JSON.parse(row.requestJson);
      } catch {
        continue;
      }

      const tradeId = Number(request?.tradeId);
      if (!Number.isInteger(tradeId) || tradeId <= 0) continue;

      if (
        selectedExecutionByTrade.get(tradeId) !== String(row.executionId) ||
        this.db.hasResolvedExecutionForTrade(tradeId, ['CLOSE', 'CLOSE_AT_MARKET'])
      ) {
        this.logger.warn(
          `[MT5] Multiple or already-resolved close operations for trade id=${tradeId}; only one operation may ever be reconciled`,
        );
        continue;
      }

      const trade = this.db.raw().prepare(
        `SELECT * FROM trades WHERE id=? LIMIT 1`,
      ).get(tradeId) as any;
      if (!trade?.ticket) continue;

      const history = await this.getMT5HistoryEntry(Number(trade.ticket));
      if (!history) continue;

      const skewMs = 5 * 60_000;
      if (history.closeTimeMsc > 0 && Number(row.createdAt) > 0 &&
          history.closeTimeMsc + skewMs < Number(row.createdAt)) {
        this.logger.warn(
          `[MT5] Close history predates execution operation=${row.executionId}; leaving operation unresolved`,
        );
        continue;
      }

      const closedAt = history.closeTimeMsc > 0
        ? history.closeTimeMsc
        : Date.now();
      const resolved = this.db.resolveReconciledFullClose(
        Number(trade.id),
        String(row.executionId),
        history.profit,
        closedAt,
        history.reason,
        {
          broker: 'mt5',
          ticket: Number(trade.ticket),
          profit: history.profit,
          closePrice: history.price,
          reason: history.reason,
          startupReconciliation: true,
        },
        Number(trade.ticket),
      );
      if (!resolved) {
        this.logger.warn(
          `[MT5] Could not resolve close operation=${row.executionId}; leaving it unresolved`,
        );
      }
    }
  }

  private assertInternalPaperState() {
    const open = this.db.getOpenTrades();
    for (const trade of open) {
      if (!(trade.volume > 0) || !(trade.entry > 0) || !Number.isFinite(trade.entry))
        throw new Error(`Invalid open paper trade id=${trade.id} symbol=${trade.symbol}`);
      if (!trade.ticket) throw new Error(`Open paper trade id=${trade.id} has no ticket`);
    }
  }

  private async resolveAuthoritativeMT5PartialLedgers(positions: any[]): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, requestJson, createdAt
      FROM execution_ledger
      WHERE status IN ('PENDING','UNKNOWN')
        AND action='PARTIAL_CLOSE'
      ORDER BY updatedAt ASC, createdAt ASC
    `).all() as Array<{ executionId: string; requestJson?: string | null; createdAt: number }>;

    const byTicket = new Map<number, any>(
      positions.map(position => [Number(position.ticket), position]),
    );
    const resolvedTrades = new Set<number>();

    for (const row of rows) {
      if (!row.requestJson) continue;

      let request: any;
      try { request = JSON.parse(row.requestJson); } catch { continue; }

      const tradeId = Number(request?.tradeId);
      if (!Number.isInteger(tradeId) || tradeId <= 0 || resolvedTrades.has(tradeId)) continue;
      if (this.db.hasResolvedExecutionForTrade(tradeId, ['PARTIAL_CLOSE'])) continue;

      const trade = this.db.raw().prepare(`SELECT * FROM trades WHERE id=? LIMIT 1`).get(tradeId) as any;
      if (!trade?.ticket || String(trade.status) !== 'open') continue;

      const live = byTicket.get(Number(trade.ticket));
      if (!live) continue;

      const brokerVolume = Number(live.volume);
      if (!(brokerVolume > 0) || !Number.isFinite(brokerVolume) ||
          brokerVolume >= Number(trade.volume) - Math.max(1e-8, Number(trade.volume) * 1e-8)) continue;

      const history = await this.getMT5HistorySnapshot(Number(trade.ticket));
      if (!history || history.closed || !(history.remainingVolume > 0) ||
          history.remainingVolume >= Number(trade.volume)) continue;

      const skewMs = 5 * 60_000;
      if (history.closeTimeMsc > 0 && Number(row.createdAt) > 0 &&
          history.closeTimeMsc + skewMs < Number(row.createdAt)) {
        this.logger.warn(
          `[MT5] Partial-close history predates execution operation=${row.executionId}; leaving operation unresolved`,
        );
        continue;
      }

      const positionTolerance = Math.max(
        1e-8,
        Number(trade.volume) * 0.02,
      );
      if (Math.abs(brokerVolume - history.remainingVolume) > positionTolerance) {
        this.logger.warn(
          `[MT5] Partial-close position/history mismatch for trade id=${tradeId}; leaving operation unresolved`,
        );
        continue;
      }

      const requestedVolume = Number(request?.volume);
      if (!(requestedVolume > 0) || !Number.isFinite(requestedVolume)) continue;

      const tolerance = Math.max(
        1e-8,
        Number(trade.volume) * 0.02,
        Number(history.remainingVolume) * 0.02,
      );
      const alreadyApplied =
        Math.abs(Number(trade.volume) - history.remainingVolume) <= tolerance;
      const requestedRemaining = Number(trade.volume) - requestedVolume;
      const expectedRemainingMatches =
        Math.abs(history.remainingVolume - requestedRemaining) <= tolerance;
      if (!alreadyApplied && !expectedRemainingMatches) {
        this.logger.warn(
          `[MT5] Partial-close history mismatch for trade id=${tradeId}; leaving operation unresolved`,
        );
        continue;
      }

      const resolved = this.db.resolveReconciledPartialClose(
        tradeId,
        String(row.executionId),
        history.remainingVolume,
        history.netProfit,
        {
          broker: 'mt5', ticket: Number(trade.ticket),
          closedVolume: Number(trade.volume) - history.remainingVolume,
          remainingVolume: history.remainingVolume,
          cumulativeRealizedProfit: history.netProfit,
          closeDealTicket: history.closeDealTicket,
          startupReconciliation: true,
        },
        history.closeDealTicket ?? Number(trade.ticket),
      );
      if (resolved) resolvedTrades.add(tradeId);
    }
  }

  private async resolveAuthoritativeMT5ModifyLedgers(
    positions: any[],
  ): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, operationKey, requestJson
      FROM execution_ledger
      WHERE status IN ('PENDING','UNKNOWN')
        AND action='MOVE_SL_TP'
      ORDER BY createdAt ASC, updatedAt ASC, executionId ASC
    `).all() as Array<{
      executionId: string;
      operationKey: string;
      requestJson?: string | null;
    }>;

    const byTrade = new Map<number, typeof rows>();
    for (const row of rows) {
      if (!row.requestJson) continue;
      try {
        const tradeId = Number(JSON.parse(row.requestJson)?.tradeId);
        if (!Number.isInteger(tradeId) || tradeId <= 0) continue;
        const existing = byTrade.get(tradeId) ?? [];
        existing.push(row);
        byTrade.set(tradeId, existing);
      } catch {
        // malformed request JSON remains unresolved and blocks startup
      }
    }

    const byTicket = new Map<number, any>(
      positions.map(position => [Number(position.ticket), position]),
    );

    for (const [tradeId, tradeRows] of byTrade) {
      // Without a broker-side operation identifier, two unknown modifications
      // cannot be safely attributed to the current SL/TP state.
      if (tradeRows.length !== 1) {
        this.logger.warn(
          `[MT5] Multiple unresolved MOVE_SL_TP operations for trade id=${tradeId}; leaving all unresolved`,
        );
        continue;
      }

      const row = tradeRows[0];
      let request: any;
      try { request = JSON.parse(row.requestJson!); }
      catch { continue; }

      const trade = this.db.raw()
        .prepare('SELECT * FROM trades WHERE id=? LIMIT 1')
        .get(tradeId) as any;
      if (!trade?.ticket || String(trade.status) !== 'open') continue;

      const live = byTicket.get(Number(trade.ticket));
      if (!live) continue;

      const newSl = Number(request?.newSl);
      const newTp = Number(request?.newTp);
      const liveSl = Number(live.sl);
      const liveTp = Number(live.tp);
      if (
        !Number.isFinite(newSl) || !Number.isFinite(newTp) ||
        !Number.isFinite(liveSl) || !Number.isFinite(liveTp) ||
        newSl <= 0 || newTp <= 0 || liveSl <= 0 || liveTp <= 0
      ) continue;

      const tolerance = (target: number) =>
        Math.max(1e-8, Math.abs(target) * 1e-6);
      if (
        Math.abs(liveSl - newSl) > tolerance(newSl) ||
        Math.abs(liveTp - newTp) > tolerance(newTp)
      ) continue;

      if (
        (trade.side === 'BUY' && !(newSl < trade.entry && newTp > trade.entry)) ||
        (trade.side === 'SELL' && !(newSl > trade.entry && newTp < trade.entry))
      ) continue;

      // The replacement pair is now authoritatively recovered. A process may
      // have stopped after creating it but before canceling the previous pair.
      // Retire only the previous operation's exact Algo IDs before settling the
      // modification; never sweep symbol-wide or manually created protection.
      const previousMoveRows = this.db.raw().prepare(`
        SELECT operationKey, requestJson, tradeId
        FROM execution_ledger
        WHERE action='MOVE_SL_TP'
          AND status='EXECUTED'
          AND (tradeId=? OR tradeId IS NULL)
        ORDER BY updatedAt DESC, executionId DESC
        LIMIT 100
      `).all(tradeId) as Array<{
        operationKey: string;
        requestJson?: string | null;
        tradeId?: number | null;
      }>;
      let previousProtectionKey: string | null = null;
      for (const previous of previousMoveRows) {
        if (String(previous.operationKey) === String(row.operationKey)) continue;
        try {
          const previousRequest = JSON.parse(String(previous.requestJson ?? 'null'));
          if (
            Number(previous.tradeId ?? previousRequest?.tradeId) === tradeId &&
            Number(previousRequest?.tradeId) === tradeId
          ) {
            previousProtectionKey = String(previous.operationKey);
            break;
          }
        } catch {
          // Malformed history cannot authorize cancellation of any broker order.
        }
      }
      if (!previousProtectionKey) {
        const openOperation = this.db.getLatestExecutedOpenOperationForTrade(tradeId);
        if (openOperation && !openOperation.conflict) {
          previousProtectionKey = String(openOperation.operationKey);
        }
      }
      if (
        previousProtectionKey &&
        previousProtectionKey !== String(row.operationKey)
      ) {
        await exec.cancelProtectionByOperationKey(
          String(trade.symbol),
          String(trade.side).toUpperCase() as 'BUY' | 'SELL',
          previousProtectionKey,
        );
      }

      const resolved = this.db.resolveReconciledSLTP(
        tradeId,
        String(row.executionId),
        newSl,
        newTp,
        {
          broker: 'mt5',
          ticket: Number(trade.ticket),
          newSl,
          newTp,
          startupReconciliation: true,
        },
        Number(trade.ticket),
      );
      if (resolved) {
        this.logger.info(
          `[MT5] startup-resolved protective-order operation=${row.operationKey}`,
        );
      }
    }
  }

  private async reconcileMT5(): Promise<unknown> {
    const r = await axios.get(`${this.config.mt5.bridgeUrl}/positions`, {
      timeout: 5_000, headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey },
    });
    if (r.data?.ok === false) throw new Error(`MT5 positions failed: ${r.data?.error ?? 'unknown error'}`);
    const positions: any[] = r.data?.positions ?? [];
    const byTicket = new Map<number, any>(positions.map(p => [Number(p.ticket), p]));
    const openTrades = this.db.getOpenTrades();
    const internalTickets = new Set(openTrades.map(t => Number(t.ticket)).filter(Boolean));

    for (const t of openTrades) {
      if (!t.ticket) throw new Error(`Open DB trade id=${t.id} has no broker ticket`);
      const live = byTicket.get(Number(t.ticket));
      if (!live) {
        const pendingClose = this.db.getLatestUnresolvedExecutionForTrade(
          t.id!,
          ['CLOSE', 'CLOSE_AT_MARKET'],
        );
        const hist = await this.getMT5HistoryEntry(Number(t.ticket));
        if (!hist) throw new Error(`MT5 position missing and no authoritative close history for ticket=${t.ticket}`);

        if (pendingClose) {
          // Let resolveAuthoritativeMT5CloseLedgers atomically settle the
          // trade + ledger after validating history timing.
          continue;
        }

        const changed = this.db.updateTradeClose(t.id!, hist.profit, Date.now(), hist.reason);
        if (!changed) throw new Error(`Could not close DB trade id=${t.id} during reconciliation`);
        continue;
      }
      if (String(live.symbol).toUpperCase() !== t.symbol.toUpperCase()) throw new Error(`MT5 symbol mismatch ticket=${t.ticket}`);
      const side = String(live.type).toUpperCase();
      if (side !== t.side) throw new Error(`MT5 side mismatch ticket=${t.ticket}: DB=${t.side} broker=${side}`);
      const brokerVol = Number(live.volume);
      if (!(brokerVol > 0) || !Number.isFinite(brokerVol)) throw new Error(`MT5 invalid broker volume ticket=${t.ticket}`);
      const volumeMismatch = Math.abs(brokerVol - t.volume) > Math.max(1e-8, t.volume * 0.02);
      const unresolvedPartial =
        t.id != null &&
        this.db.hasUnresolvedExecutionForTrade(Number(t.id), ['PARTIAL_CLOSE']);
      if (volumeMismatch && !(unresolvedPartial && brokerVol < t.volume)) {
        throw new Error(`MT5 volume mismatch ticket=${t.ticket}: DB=${t.volume} broker=${brokerVol}`);
      }
      const sl = Number(live.sl), tp = Number(live.tp);
      if (![sl, tp].every(Number.isFinite) || sl <= 0 || tp <= 0) throw new Error(`MT5 protective order state invalid ticket=${t.ticket}`);
      if ((t.side === 'BUY' && (sl >= t.entry || tp <= t.entry)) || (t.side === 'SELL' && (sl <= t.entry || tp >= t.entry)))
        throw new Error(`MT5 protective order direction invalid ticket=${t.ticket}`);
      if (volumeMismatch) {
        this.db.raw().prepare(`UPDATE trades SET sl=?, tp=? WHERE id=? AND status='open'`).run(sl, tp, t.id!);
      } else {
        this.db.raw().prepare(`UPDATE trades SET sl=?, tp=?, volume=? WHERE id=? AND status='open'`).run(sl, tp, brokerVol, t.id!);
      }
    }

    for (const p of positions) {
      const ticket = Number(p.ticket);
      const isBotPosition = internalTickets.has(ticket) || String(p.comment ?? '').startsWith('ta_');
      if (isBotPosition && !internalTickets.has(ticket))
        throw new Error(`Hidden MT5 bot position detected ticket=${ticket} without internal ledger`);
    }

    await this.resolveAuthoritativeMT5CloseLedgers();
    await this.resolveAuthoritativeMT5PartialLedgers(positions);
    await this.resolveAuthoritativeMT5ModifyLedgers(positions);
    return positions;
  }

  private async getMT5HistorySnapshot(ticket: number): Promise<{
    price: number; netProfit: number; remainingVolume: number; closed: boolean;
    reason: string; closeDealTicket?: number; closeTimeMsc: number;
  } | null> {
    const r = await axios.get(`${this.config.mt5.bridgeUrl}/history`, {
      params: { position: ticket }, timeout: 5_000,
      headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey },
    });
    if (r.data?.ok === false) return null;

    const price = Number(r.data?.close_price);
    const netProfit = Number(r.data?.net_profit);
    const remainingVolume = Number(r.data?.remaining_volume ?? 0);
    const closed = r.data?.closed === true;
    if (!Number.isFinite(price) || !Number.isFinite(netProfit) ||
        !Number.isFinite(remainingVolume) || remainingVolume < 0) return null;

    const reason = String(r.data?.close_reason ?? 'manual').toLowerCase();
    const closeDealTicket = Number(r.data?.close_deal_ticket);
    const closeTimeMsc = Number(r.data?.close_time_msc ?? 0);
    if (!Number.isFinite(closeTimeMsc) || closeTimeMsc < 0) return null;
    return {
      price, netProfit, remainingVolume, closed, closeTimeMsc,
      reason: reason.includes('sl') ? 'SL' : reason.includes('tp') ? 'TP' : 'offline_close',
      ...(Number.isInteger(closeDealTicket) && closeDealTicket > 0 ? { closeDealTicket } : {}),
    };
  }

  private async getMT5HistoryEntry(ticket: number): Promise<{ price: number; profit: number; reason: string; closeTimeMsc: number } | null> {
    const history = await this.getMT5HistorySnapshot(ticket);
    if (!history || !history.closed) return null;
    return {
      price: history.price,
      profit: history.netProfit,
      reason: history.reason,
      closeTimeMsc: history.closeTimeMsc,
    };
  }
  private async resolveAuthoritativeBinanceModifyLedgers(
    exec: BinanceExecutor,
    positions: any[],
  ): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, operationKey, requestJson
      FROM execution_ledger
      WHERE status IN ('PENDING','UNKNOWN')
        AND action='MOVE_SL_TP'
      ORDER BY createdAt ASC, updatedAt ASC, executionId ASC
    `).all() as Array<{
      executionId: string;
      operationKey: string;
      requestJson?: string | null;
    }>;

    const bySymbol = new Map<string, any>(
      positions.map(position => [String(position.symbol).toUpperCase(), position]),
    );
    const selectedByTrade = new Map<number, string>();
    for (const row of rows) {
      if (!row.requestJson) continue;
      try {
        const tradeId = Number(JSON.parse(row.requestJson)?.tradeId);
        if (Number.isInteger(tradeId) && tradeId > 0 && !selectedByTrade.has(tradeId)) {
          selectedByTrade.set(tradeId, String(row.executionId));
        }
      } catch {
        // malformed request JSON stays unresolved and blocks startup
      }
    }

    for (const row of rows) {
      if (!row.requestJson) continue;

      let request: any;
      try { request = JSON.parse(row.requestJson); }
      catch { continue; }

      const tradeId = Number(request?.tradeId);
      if (
        !Number.isInteger(tradeId) ||
        tradeId <= 0 ||
        selectedByTrade.get(tradeId) !== String(row.executionId)
      ) continue;

      const trade = this.db.raw()
        .prepare('SELECT * FROM trades WHERE id=? LIMIT 1')
        .get(tradeId) as any;
      if (!trade?.ticket || String(trade.status) !== 'open') continue;

      const live = bySymbol.get(String(trade.symbol).toUpperCase());
      if (!live || Math.abs(Number(live.positionAmt)) < 0.0001) continue;
      if (
        (String(trade.side).toUpperCase() === 'BUY' && Number(live.positionAmt) <= 0) ||
        (String(trade.side).toUpperCase() === 'SELL' && Number(live.positionAmt) >= 0)
      ) {
        throw new Error(`Binance live position side differs from the trade during protection recovery for trade id=${tradeId}`);
      }

      let phase = String(request?.phase ?? '');
      const transitionPhases = new Set([
        'PREPARED',
        'OLD_CANCEL_REQUESTED',
        'OLD_CANCEL_VERIFIED',
        'NEW_PAIR_REQUESTED',
        'RESTORE_REQUESTED',
        'BLOCKED_UNKNOWN',
      ]);

      if (transitionPhases.has(phase)) {
        const oldProtectionKey = String(request?.oldProtectionKey ?? '').trim();
        const newProtectionKey = String(request?.newProtectionKey ?? row.operationKey).trim();
        const restoreProtectionKey = String(request?.restoreProtectionKey ?? '').trim();
        const oldProtection = request?.oldProtection ?? {};
        const oldSl = Number(oldProtection.slPrice);
        const oldTp = Number(oldProtection.tpPrice);
        const expectedQuantity = Number(request?.quantity ?? trade.volume);
        if (
          !oldProtectionKey || !newProtectionKey || !restoreProtectionKey ||
          !(oldSl > 0) || !(oldTp > 0) ||
          !Number.isFinite(oldSl) || !Number.isFinite(oldTp) ||
          !(expectedQuantity > 0) || !Number.isFinite(expectedQuantity)
        ) {
          throw new Error(`Binance transitional protection state is incomplete for trade id=${tradeId}; startup remains blocked`);
        }

        const activePairIsValid = async (key: string, slPrice: number, tpPrice: number): Promise<boolean> => {
          const recoveredPair = await exec.recoverProtectionByOperation(String(trade.symbol), key);
          if (!recoveredPair?.sl || !recoveredPair?.tp) return false;
          const orders = await exec.getOpenAlgoOrders(String(trade.symbol));
          const slClientId = String(recoveredPair.sl.clientOrderId ?? '');
          const tpClientId = String(recoveredPair.tp.clientOrderId ?? '');
          const slOpen = orders.find((order: any) => slClientId !== '' && String(order.clientOrderId ?? '') === slClientId);
          const tpOpen = orders.find((order: any) => tpClientId !== '' && String(order.clientOrderId ?? '') === tpClientId);
          const closeSide = String(trade.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
          const tolerance = (target: number) => Math.max(1e-8, Math.abs(target) * 1e-6);
          return !!slOpen && !!tpOpen &&
            String(recoveredPair.sl.status ?? '').toUpperCase() === 'NEW' &&
            String(recoveredPair.tp.status ?? '').toUpperCase() === 'NEW' &&
            String(slOpen.side ?? '').toUpperCase() === closeSide &&
            String(tpOpen.side ?? '').toUpperCase() === closeSide &&
            String(slOpen.type ?? '').toUpperCase() === 'STOP_MARKET' &&
            String(tpOpen.type ?? '').toUpperCase() === 'TAKE_PROFIT_MARKET' &&
            String(slOpen.closePosition).toLowerCase() === 'true' &&
            String(tpOpen.closePosition).toLowerCase() === 'true' &&
            Number.isFinite(Number(slOpen.stopPrice)) &&
            Number.isFinite(Number(tpOpen.stopPrice)) &&
            Math.abs(Number(slOpen.stopPrice) - slPrice) <= tolerance(slPrice) &&
            Math.abs(Number(tpOpen.stopPrice) - tpPrice) <= tolerance(tpPrice);
        };

        const newSl = Number(request?.requestedProtection?.slPrice ?? request?.newSl);
        const newTp = Number(request?.requestedProtection?.tpPrice ?? request?.newTp);
        const newPairValid =
          newSl > 0 && newTp > 0 &&
          Number.isFinite(newSl) && Number.isFinite(newTp) &&
          await activePairIsValid(newProtectionKey, newSl, newTp);

        if (newPairValid) {
          await exec.cancelProtectionByOperationKey(
            String(trade.symbol),
            String(trade.side).toUpperCase() as 'BUY' | 'SELL',
            oldProtectionKey,
          );
          const updatedRequest = {
            ...request,
            phase: 'NEW_PAIR_VERIFIED',
            activeProtectionKey: newProtectionKey,
            updatedAt: Date.now(),
          };
          if (!this.db.updateExecutionRequest(String(row.executionId), updatedRequest)) {
            throw new Error(`Could not persist recovered new Binance protection pair for trade id=${tradeId}`);
          }
          request = updatedRequest;
          phase = 'NEW_PAIR_VERIFIED';
        } else {
          await exec.cancelProtectionByOperationKey(
            String(trade.symbol),
            String(trade.side).toUpperCase() as 'BUY' | 'SELL',
            newProtectionKey,
          );
          const newIds = new Set([
            String(request?.requestedProtection?.slClientAlgoId ?? ''),
            String(request?.requestedProtection?.tpClientAlgoId ?? ''),
          ].filter(Boolean));
          if ((await exec.getOpenAlgoOrders(String(trade.symbol))).some((order: any) =>
            newIds.has(String(order.clientOrderId ?? '')),
          )) {
            throw new Error(`Partial replacement protection remains open for trade id=${tradeId}; startup remains blocked`);
          }

          const oldPairValid = await activePairIsValid(oldProtectionKey, oldSl, oldTp);
          if (oldPairValid) {
            const retained = {
              ...request,
              phase: 'OLD_PAIR_RETAINED',
              activeProtectionKey: oldProtectionKey,
              updatedAt: Date.now(),
            };
            if (!this.db.updateExecutionRequest(String(row.executionId), retained)) {
              throw new Error(`Could not persist retained Binance protection for trade id=${tradeId}`);
            }
            const failed = this.db.updateExecutionLedger(String(row.executionId), {
              status: 'FAILED',
              result: {
                broker: 'binance',
                startupReconciliation: true,
                phase: 'OLD_PAIR_RETAINED',
                activeProtectionKey: oldProtectionKey,
                activeSl: oldSl,
                activeTp: oldTp,
              },
              error: 'Requested SL/TP change was interrupted; the verified prior protection pair remains active',
            });
            if (!failed) throw new Error(`Could not settle interrupted Binance modification for trade id=${tradeId}`);
            this.logger.warn(`[Binance] startup retained verified prior protection for trade id=${tradeId}`);
            continue;
          }

          const restorePairAlreadyValid = await activePairIsValid(restoreProtectionKey, oldSl, oldTp);
          if (!restorePairAlreadyValid) {
            const restoreRequested = {
              ...request,
              phase: 'RESTORE_REQUESTED',
              activeProtectionKey: null,
              updatedAt: Date.now(),
            };
            if (!this.db.updateExecutionRequest(String(row.executionId), restoreRequested)) {
              throw new Error(`Could not persist Binance protection restoration intent for trade id=${tradeId}`);
            }
            request = restoreRequested;
            await exec.cancelProtectionByOperationKey(
              String(trade.symbol),
              String(trade.side).toUpperCase() as 'BUY' | 'SELL',
              oldProtectionKey,
            );
            if ((await exec.getOpenAlgoOrders(String(trade.symbol))).some((order: any) => {
              const oldIds = new Set([
                String(oldProtection.slClientAlgoId ?? ''),
                String(oldProtection.tpClientAlgoId ?? ''),
              ].filter(Boolean));
              return oldIds.has(String(order.clientOrderId ?? ''));
            })) {
              throw new Error(`Prior protection remains partially open for trade id=${tradeId}; startup remains blocked`);
            }
            const restored = await exec.restoreProtectionPairForReconciliation(
              Number(trade.ticket),
              String(trade.symbol),
              String(trade.side).toUpperCase() as 'BUY' | 'SELL',
              expectedQuantity,
              restoreProtectionKey,
              oldSl,
              oldTp,
            );
            if (!restored) {
              throw new Error(`Could not restore Binance protection after interrupted modification for trade id=${tradeId}`);
            }
          }

          if (!(await activePairIsValid(restoreProtectionKey, oldSl, oldTp))) {
            throw new Error(`Restored Binance protection could not be verified for trade id=${tradeId}; startup remains blocked`);
          }
          const restoredRequest = {
            ...request,
            phase: 'RESTORE_VERIFIED',
            activeProtectionKey: restoreProtectionKey,
            updatedAt: Date.now(),
          };
          if (!this.db.updateExecutionRequest(String(row.executionId), restoredRequest)) {
            throw new Error(`Could not persist verified Binance protection restoration for trade id=${tradeId}`);
          }
          const failed = this.db.updateExecutionLedger(String(row.executionId), {
            status: 'FAILED',
            result: {
              broker: 'binance',
              startupReconciliation: true,
              phase: 'RESTORE_VERIFIED',
              activeProtectionKey: restoreProtectionKey,
              activeSl: oldSl,
              activeTp: oldTp,
            },
            error: 'Requested SL/TP change was interrupted; the verified prior targets were restored',
          });
          if (!failed) throw new Error(`Could not settle restored Binance protection for trade id=${tradeId}`);
          this.logger.warn(`[Binance] startup restored prior protection for trade id=${tradeId}`);
          continue;
        }
      }

      if (phase === 'RESTORE_VERIFIED' || phase === 'OLD_PAIR_RETAINED') {
        const activeKey = String(request?.activeProtectionKey ?? '').trim();
        const oldProtection = request?.oldProtection ?? {};
        const activeSl = Number(oldProtection.slPrice);
        const activeTp = Number(oldProtection.tpPrice);
        if (
          !activeKey ||
          !(activeSl > 0) || !(activeTp > 0) ||
          !Number.isFinite(activeSl) || !Number.isFinite(activeTp)
        ) {
          throw new Error(`Binance protection recovery state is incomplete for trade id=${tradeId}; startup remains blocked`);
        }

        const activePair = await exec.recoverProtectionByOperation(
          String(trade.symbol),
          activeKey,
        );
        const activeOpenOrders = await exec.getOpenAlgoOrders(String(trade.symbol));
        const activeSlClientId = String((activePair?.sl as any)?.clientOrderId ?? '');
        const activeTpClientId = String((activePair?.tp as any)?.clientOrderId ?? '');
        const activeSlOrder = activeOpenOrders.find((order: any) =>
          activeSlClientId !== '' && String(order.clientOrderId ?? '') === activeSlClientId,
        );
        const activeTpOrder = activeOpenOrders.find((order: any) =>
          activeTpClientId !== '' && String(order.clientOrderId ?? '') === activeTpClientId,
        );
        const closeSide = String(trade.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
        const tolerance = (target: number) => Math.max(1e-8, Math.abs(target) * 1e-6);
        const activePairValid =
          !!activePair?.sl && !!activePair?.tp &&
          !!activeSlOrder && !!activeTpOrder &&
          String(activePair.sl.status ?? '').toUpperCase() === 'NEW' &&
          String(activePair.tp.status ?? '').toUpperCase() === 'NEW' &&
          String(activeSlOrder.side ?? '').toUpperCase() === closeSide &&
          String(activeTpOrder.side ?? '').toUpperCase() === closeSide &&
          String(activeSlOrder.type ?? '').toUpperCase() === 'STOP_MARKET' &&
          String(activeTpOrder.type ?? '').toUpperCase() === 'TAKE_PROFIT_MARKET' &&
          String(activeSlOrder.closePosition).toLowerCase() === 'true' &&
          String(activeTpOrder.closePosition).toLowerCase() === 'true' &&
          Number.isFinite(Number(activeSlOrder.stopPrice)) &&
          Number.isFinite(Number(activeTpOrder.stopPrice)) &&
          Math.abs(Number(activeSlOrder.stopPrice) - activeSl) <= tolerance(activeSl) &&
          Math.abs(Number(activeTpOrder.stopPrice) - activeTp) <= tolerance(activeTp);

        if (!activePairValid) {
          throw new Error(`Binance ${phase} state does not have a verified active protection pair for trade id=${tradeId}; startup remains blocked`);
        }

        const requestedIds = new Set([
          String(request?.requestedProtection?.slClientAlgoId ?? ''),
          String(request?.requestedProtection?.tpClientAlgoId ?? ''),
        ]);
        if (requestedIds.size > 0 && !requestedIds.has('')) {
          const stillOpen = activeOpenOrders.some((order: any) =>
            requestedIds.has(String(order.clientOrderId ?? '')),
          );
          if (stillOpen) {
            throw new Error(`Partial replacement protection remains open for trade id=${tradeId}; startup remains blocked`);
          }
        }

        const failed = this.db.updateExecutionLedger(String(row.executionId), {
          status: 'FAILED',
          result: {
            broker: 'binance',
            startupReconciliation: true,
            phase,
            activeProtectionKey: activeKey,
            activeSl,
            activeTp,
          },
          error: `Requested SL/TP change did not complete; verified prior/restored protection remains active (phase=${phase})`,
        });
        if (!failed) {
          throw new Error(`Could not settle recovered Binance protection state for trade id=${tradeId}`);
        }
        this.logger.warn(
          `[Binance] startup verified ${phase} protection for trade id=${tradeId}; requested SL/TP change remains failed`,
        );
        continue;
      }

      const newSl = Number(request?.newSl);
      const newTp = Number(request?.newTp);
      if (
        !(newSl > 0) ||
        !(newTp > 0) ||
        !Number.isFinite(newSl) ||
        !Number.isFinite(newTp)
      ) continue;

      const recovered = await exec.recoverProtectionByOperation(
        String(trade.symbol),
        String(row.operationKey),
      );
      const sl = recovered?.sl;
      const tp = recovered?.tp;
      if (!sl || !tp) continue;

      const slStatus = String(sl.status ?? '').toUpperCase();
      const tpStatus = String(tp.status ?? '').toUpperCase();
      if (
        (slStatus && slStatus !== 'NEW') ||
        (tpStatus && tpStatus !== 'NEW')
      ) continue;

      const closeSide = String(trade.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
      if (
        String(sl.side ?? '').toUpperCase() !== closeSide ||
        String(tp.side ?? '').toUpperCase() !== closeSide
      ) continue;

      const tolerance = (target: number) =>
        Math.max(1e-8, Math.abs(target) * 1e-6);
      const slStop = Number(sl.stopPrice);
      const tpStop = Number(tp.stopPrice);
      const tpPrice = Number(tp.price);

      if (
        !/STOP_MARKET|STOP_LOSS/.test(String(sl.type ?? '').toUpperCase()) ||
        !Number.isFinite(slStop) ||
        Math.abs(slStop - newSl) > tolerance(newSl)
      ) continue;

      if (
        !/TAKE_PROFIT_MARKET|TAKE_PROFIT/.test(String(tp.type ?? '').toUpperCase()) ||
        !(
          (Number.isFinite(tpStop) && Math.abs(tpStop - newTp) <= tolerance(newTp)) ||
          (Number.isFinite(tpPrice) && Math.abs(tpPrice - newTp) <= tolerance(newTp))
        )
      ) continue;

      const resolved = this.db.resolveReconciledSLTP(
        tradeId,
        String(row.executionId),
        newSl,
        newTp,
        {
          broker: 'binance',
          ticket: Number(trade.ticket),
          newSl,
          newTp,
          slOrderId: Number(sl.orderId),
          tpOrderId: Number(tp.orderId),
          startupReconciliation: true,
        },
        Number(sl.orderId) > 0 ? Number(sl.orderId) : undefined,
      );
      if (resolved) {
        this.logger.info(
          `[Binance] startup-resolved protective-order operation=${row.operationKey}`,
        );
      }
    }
  }

  private async resolveAuthoritativeBinanceLedgers(
    exec: BinanceExecutor,
    positions: any[],
  ): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, operationKey, action, symbol, volume, requestJson, createdAt
      FROM execution_ledger
      WHERE status IN ('PENDING','UNKNOWN')
        AND action IN ('CLOSE','CLOSE_AT_MARKET','PARTIAL_CLOSE')
      ORDER BY createdAt ASC, updatedAt ASC, executionId ASC
    `).all() as Array<{
      executionId: string;
      operationKey: string;
      action: string;
      symbol?: string | null;
      volume?: number | null;
      requestJson?: string | null;
      createdAt: number;
    }>;

    const selectedByTrade = new Map<number, string>();
    for (const row of rows) {
      if (!row.requestJson) continue;
      try {
        const request = JSON.parse(row.requestJson);
        const tradeId = Number(request?.tradeId);
        if (
          Number.isInteger(tradeId) &&
          tradeId > 0 &&
          !selectedByTrade.has(tradeId)
        ) {
          selectedByTrade.set(tradeId, String(row.executionId));
        }
      } catch {
        // malformed request JSON remains unresolved and blocks startup
      }
    }

    const bySymbol = new Map<string, any>(
      positions.map(position => [String(position.symbol).toUpperCase(), position]),
    );
    const fx = new CurrencyConversionProvider(
      new MarketScanner(this.config),
      this.config.accountCurrency ?? 'USD',
    );

    for (const row of rows) {
      if (!row.requestJson) continue;

      let request: any;
      try {
        request = JSON.parse(row.requestJson);
      } catch {
        continue;
      }

      const tradeId = Number(request?.tradeId);
      if (
        !Number.isInteger(tradeId) ||
        tradeId <= 0 ||
        selectedByTrade.get(tradeId) !== String(row.executionId)
      ) {
        continue;
      }

      const trade = this.db.raw()
        .prepare('SELECT * FROM trades WHERE id=? LIMIT 1')
        .get(tradeId) as any;
      if (!trade?.ticket || String(trade.status) !== 'open') continue;

      const recovered = await exec.recoverOperation(
        String(trade.symbol),
        String(row.operationKey),
        Number(trade.entry),
        trade.side,
      );
      if (!recovered || recovered.status !== 'FILLED') continue;
      if (!(recovered.executedQty > 0) || !Number.isFinite(recovered.executedQty)) continue;

      const expectedVolume = row.action === 'PARTIAL_CLOSE'
        ? Number(request?.volume ?? row.volume)
        : Number(row.volume ?? trade.volume);
      if (
        !(expectedVolume > 0) ||
        Math.abs(recovered.executedQty - expectedVolume) >
          Math.max(1e-8, expectedVolume * 0.0001)
      ) {
        continue;
      }

      if (
        recovered.realizedProfit == null ||
        !Number.isFinite(recovered.realizedProfit)
      ) {
        continue;
      }

      const profitCurrency = recovered.realizedProfitCurrency;
      let accountProfit = Number(recovered.realizedProfit);
      if (!Number.isFinite(accountProfit)) continue;
      const accountCurrency = (this.config.accountCurrency ?? 'USD').trim().toUpperCase();
      const currency = String(profitCurrency ?? '').trim().toUpperCase();
      if (currency && currency !== accountCurrency &&
          !(accountCurrency === 'USD' && ['USDT','USDC','BUSD'].includes(currency))) {
        const rate = await fx.getRate(currency);
        if (!(rate != null && rate > 0 && Number.isFinite(rate))) continue;
        accountProfit *= rate;
      }
      if (!Number.isFinite(accountProfit)) continue;

      const live = bySymbol.get(String(trade.symbol).toUpperCase());
      if (row.action === 'PARTIAL_CLOSE') {
        if (!live) continue;
        const remaining = Math.abs(Number(live.positionAmt));
        if (!(remaining > 0) || !Number.isFinite(remaining)) continue;
        if (
          Math.abs(remaining - (Number(trade.volume) - recovered.executedQty)) >
          Math.max(1e-8, Number(trade.volume) * 0.0001)
        ) {
          continue;
        }

        const cumulative = Number(trade.realizedProfit ?? 0) + accountProfit;
        if (!Number.isFinite(cumulative)) continue;

        const resolved = this.db.resolveReconciledPartialClose(
          tradeId,
          String(row.executionId),
          +remaining.toFixed(8),
          cumulative,
          {
            broker: 'binance',
            ticket: Number(trade.ticket),
            brokerOrderId: recovered.orderId,
            closedVolume: recovered.executedQty,
            remainingVolume: +remaining.toFixed(8),
            profit: accountProfit,
            cumulativeRealizedProfit: cumulative,
            startupReconciliation: true,
          },
          recovered.orderId,
        );
        if (resolved) {
          this.logger.info(
            `[Binance] startup-resolved partial operation=${row.operationKey}`,
          );
        }
        continue;
      }

      const positionRemaining = live ? Math.abs(Number(live.positionAmt)) : 0;
      if (live && positionRemaining >= 0.0001) continue;

      const exitPrice = Number(recovered.avgPrice);
      if (!(exitPrice > 0) || !Number.isFinite(exitPrice)) continue;

      const requestedReason = String(request?.reason ?? 'MANUAL').toUpperCase();
      const reason = ['TP','SL','TIMEOUT','MANUAL'].includes(requestedReason)
        ? requestedReason
        : 'MANUAL';

      const resolved = this.db.resolveReconciledFullClose(
        tradeId,
        String(row.executionId),
        accountProfit,
        Date.now(),
        reason,
        {
          broker: 'binance',
          ticket: Number(trade.ticket),
          brokerOrderId: recovered.orderId,
          executedQty: recovered.executedQty,
          realizedProfit: accountProfit,
          avgPrice: exitPrice,
          startupReconciliation: true,
        },
        recovered.orderId,
      );
      if (resolved) {
        this.logger.info(
          `[Binance] startup-resolved close operation=${row.operationKey}`,
        );
      }
    }
  }

  private async resolveHistoricalProtectionFailureConversionRate(
    scanner: MarketScanner,
    quoteCurrency: string,
    accountCurrency: string,
    fillTimestamp: number,
  ): Promise<number> {
    const quote = String(quoteCurrency ?? '').trim().toUpperCase();
    const account = String(accountCurrency ?? '').trim().toUpperCase();
    if (!quote || !account) {
      throw new Error('Historical FX conversion requires explicit quote and account currencies');
    }
    if (quote === account) return 1;
    if (account === 'USD' && ['USD', 'USDT', 'USDC', 'BUSD'].includes(quote)) return 1;
    if (!(fillTimestamp > 0) || !Number.isFinite(fillTimestamp)) {
      throw new Error(
        `Historical FX conversion timestamp is missing for ${quote}->${account}`,
      );
    }

    // Binance commonly lists account-currency conversion pairs with the
    // account asset as base and the trading quote asset (for example USDT)
    // as quote. Load that orientation first; the resolver below inverts it
    // when computing the original quote-to-account direction.
    const series = await loadHistoricalCurrencySeries(
      account,
      quote,
      async (symbol, count) => {
        const candles = await scanner.fetchCandles(symbol, 'D1', count);
        return candles.map(candle => ({
          time: Number(candle.time),
          close: Number(candle.close),
        }));
      },
      2000,
    );
    const rate = resolveHistoricalQuoteToAccount(
      quote,
      account,
      fillTimestamp,
      series,
    );
    if (!(rate != null && rate > 0 && Number.isFinite(rate))) {
      throw new Error(
        `Timestamp-aligned FX conversion unavailable or stale at fill time: ${quote}->${account} @${fillTimestamp}`,
      );
    }
    return rate;
  }

  private async resolveProtectionFailureEmergencyCloseLedgers(
    exec: BinanceExecutor,
  ): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, operationKey, symbol, volume, requestJson, resultJson, brokerOrderId, status, createdAt
      FROM execution_ledger
      WHERE status IN ('PENDING', 'UNKNOWN')
        AND action='PROTECTION_FAIL_CLOSE'
      ORDER BY createdAt ASC, updatedAt ASC, executionId ASC
    `).all() as Array<{
      executionId: string;
      operationKey: string;
      symbol?: string | null;
      volume?: number | null;
      requestJson?: string | null;
      resultJson?: string | null;
      brokerOrderId?: string | null;
      status: string;
      createdAt: number;
    }>;

    if (rows.length === 0) return;

    const accountCurrency = String(this.config.accountCurrency ?? 'USD').trim().toUpperCase();
    const conversionScanner = new MarketScanner(this.config);

    for (const row of rows) {
      try {
        let request: any;
        try {
          request = JSON.parse(String(row.requestJson ?? 'null'));
        } catch {
          throw new Error('Emergency-close request JSON is malformed');
        }
        if (!request || request.schemaVersion !== 1) {
          throw new Error('Emergency-close request schema is missing or unsupported');
        }
        if (
          request.protectionCleanupState !==
          'VERIFIED_NO_OPERATION_OWNED_ORDERS_ACTIVE'
        ) {
          throw new Error(
            'Emergency-close ledger has no durable proof that operation-owned protection orders were canceled/terminal before market close; operator reconciliation is required',
          );
        }
        if (request.submissionState === 'PRECHECK_NOT_STARTED') {
          throw new Error('Emergency-close precheck failed before any broker order was armed; operator reconciliation is required and no automatic resend is allowed');
        }
        if (
          request.submissionState != null &&
          request.submissionState !== 'SUBMISSION_ARMED'
        ) {
          throw new Error('Emergency-close submission state is unknown or unsupported');
        }

        const parentOperationKey = String(request.parentOperationKey ?? '');
        const symbol = String(request.symbol ?? row.symbol ?? '').trim().toUpperCase();
        const side = String(request.entrySide ?? request.signal?.side ?? '').trim().toUpperCase();
        const quantity = Number(request.requestedQuantity ?? row.volume);
        const positionBeforeSigned = Number(request.positionBeforeSignedAmount);
        const positionBeforeAmount = Number(request.positionBeforeAmount);
        const storedEmergencyClientId = String(request.emergencyClientOrderId ?? '');
        const parentClientOrderId = String(request.parentClientOrderId ?? '');
        const signal = request.signal;
        if (
          !parentOperationKey ||
          !symbol ||
          !['BUY', 'SELL'].includes(side) ||
          !signal ||
          String(row.symbol ?? '').trim().toUpperCase() !== symbol ||
          String(signal.symbol ?? '').trim().toUpperCase() !== symbol ||
          String(signal.side ?? '').trim().toUpperCase() !== side ||
          !Number.isFinite(Number(signal.sl)) || !(Number(signal.sl) > 0) ||
          !Number.isFinite(Number(signal.tp)) || !(Number(signal.tp) > 0) ||
          !(quantity > 0) ||
          !Number.isFinite(quantity) ||
          (row.volume != null && (!Number.isFinite(Number(row.volume)) ||
            Math.abs(Number(row.volume) - quantity) > Math.max(1e-8, quantity * 0.0001))) ||
          !Number.isFinite(positionBeforeSigned) ||
          !(positionBeforeAmount > 0) ||
          !Number.isFinite(positionBeforeAmount) ||
          Math.abs(Math.abs(positionBeforeSigned) - positionBeforeAmount) > Math.max(1e-8, quantity * 0.0001)
        ) {
          throw new Error('Emergency-close identity, quantity, or signed position snapshot is invalid');
        }

        const quoteCurrency = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
        if (!quoteCurrency) {
          throw new Error('Emergency-close symbol has no supported authoritative quote currency');
        }

        if (this.config.binance.futures) {
          if (
            (side === 'BUY' && positionBeforeSigned <= 0) ||
            (side === 'SELL' && positionBeforeSigned >= 0)
          ) {
            throw new Error('Stored Futures position direction conflicts with the entry side');
          }
        } else if (side !== 'BUY' || positionBeforeSigned <= 0) {
          throw new Error('Binance Spot emergency close requires a positive long inventory');
        }

        const childOperationKey = String(row.operationKey ?? '');
        const expectedEmergencyOperationKey = 'PROTECTION_FAIL:' + parentOperationKey;
        const expectedEmergencyClientId = exec.clientOrderIdForOperationKey(expectedEmergencyOperationKey);
        const expectedParentClientId = exec.clientOrderIdForOperationKey(parentOperationKey);
        if (
          childOperationKey !== expectedEmergencyOperationKey ||
          storedEmergencyClientId !== expectedEmergencyClientId ||
          parentClientOrderId !== expectedParentClientId
        ) {
          throw new Error('Emergency-close operation key or clientOrderId does not match its parent OPEN identity');
        }

        const parent = this.db.getExecutionByOperationKey(parentOperationKey);
        if (
          !parent ||
          String(parent.action) !== 'OPEN' ||
          !['PENDING', 'UNKNOWN'].includes(String(parent.status))
        ) {
          throw new Error('Matching parent OPEN ledger is missing, terminal, or has an unexpected action');
        }

        let parentRequest: any;
        try {
          parentRequest = JSON.parse(String(parent.requestJson ?? 'null'));
        } catch {
          throw new Error('Parent OPEN request JSON is malformed');
        }
        const parentSignal = parentRequest?.signal;
        const timeframe = String(parentRequest.timeframe ?? signal.timeframe ?? '');
        if (!isTimeframe(timeframe)) {
          throw new Error('Emergency-close recovery has no valid original OPEN timeframe');
        }
        if (
          !parentSignal ||
          String(parentSignal.symbol ?? '').trim().toUpperCase() !== symbol ||
          String(parentSignal.side ?? '').trim().toUpperCase() !== side ||
          Number(parentSignal.timestamp) !== Number(signal.timestamp) ||
          Number(parentSignal.price) !== Number(signal.price) ||
          Number(parentSignal.sl) !== Number(signal.sl) ||
          Number(parentSignal.tp) !== Number(signal.tp) ||
          String(parentSignal.source ?? '') !== String(signal.source ?? '')
        ) {
          throw new Error('Parent OPEN request signal identity does not match the emergency close');
        }

        const entryFill = await exec.recoverOperationFillDetails(
          symbol,
          parentOperationKey,
          quantity,
        );
        if (!entryFill || entryFill.status !== 'FILLED') {
          throw new Error('Exact parent OPEN fill could not be recovered authoritatively');
        }
        const closeFill = await exec.recoverOperationFillDetails(
          symbol,
          expectedEmergencyOperationKey,
          quantity,
        );
        if (!closeFill || closeFill.status !== 'FILLED') {
          throw new Error('Exact emergency-close fill could not be recovered authoritatively');
        }
        if (
          entryFill.clientOrderId !== expectedParentClientId ||
          closeFill.clientOrderId !== expectedEmergencyClientId ||
          (row.brokerOrderId != null && String(row.brokerOrderId) !== String(closeFill.orderId)) ||
          Math.abs(entryFill.executedQty - quantity) > Math.max(1e-8, quantity * 0.0001) ||
          Math.abs(closeFill.executedQty - quantity) > Math.max(1e-8, quantity * 0.0001) ||
          !(entryFill.avgPrice > 0) ||
          !(closeFill.avgPrice > 0)
        ) {
          throw new Error('Recovered OPEN/emergency-close fill identity, quantity, or price is invalid');
        }

        const hintedEntryOrderId = Number(request.entryEvidence?.orderId);
        if (
          Number.isFinite(hintedEntryOrderId) &&
          hintedEntryOrderId > 0 &&
          hintedEntryOrderId !== entryFill.orderId
        ) {
          throw new Error('Recovered parent OPEN order id conflicts with the stored entry evidence');
        }

        const after = await exec.getPosition(symbol);
        if (!after || !Number.isFinite(Number(after.positionAmt))) {
          throw new Error('Post-emergency-close position state is unavailable or invalid');
        }
        const actualSignedAfter = Number(after.positionAmt);
        const expectedSignedAfter = this.config.binance.futures
          ? positionBeforeSigned - (side === 'BUY' ? closeFill.executedQty : -closeFill.executedQty)
          : positionBeforeSigned - closeFill.executedQty;
        const tolerance = Math.max(getSymbolSpec(symbol).volumeStep, quantity * 0.0001);
        if (
          expectedSignedAfter < -tolerance && !this.config.binance.futures ||
          !Number.isFinite(expectedSignedAfter) ||
          Math.abs(actualSignedAfter - expectedSignedAfter) > tolerance
        ) {
          throw new Error(
            'Emergency-close inventory delta is not authoritative: before=' +
            positionBeforeSigned + ' expectedAfter=' + expectedSignedAfter +
            ' actualAfter=' + actualSignedAfter,
          );
        }

        let exitProfitQuote: number;
        let exitProfitCurrency = quoteCurrency;
        if (this.config.binance.futures) {
          const recoveredPnl = await exec.recoverOrderByClientId(
            symbol,
            expectedEmergencyClientId,
            entryFill.avgPrice,
            side as 'BUY' | 'SELL',
          );
          if (
            !recoveredPnl ||
            recoveredPnl.status !== 'FILLED' ||
            Number(recoveredPnl.orderId) !== closeFill.orderId ||
            Math.abs(recoveredPnl.executedQty - quantity) > Math.max(1e-8, quantity * 0.0001) ||
            recoveredPnl.realizedProfit == null ||
            !Number.isFinite(recoveredPnl.realizedProfit) ||
            String(recoveredPnl.realizedProfitCurrency ?? '').trim().toUpperCase() !== quoteCurrency
          ) {
            throw new Error('Futures emergency-close realized PnL or quote currency could not be recovered authoritatively');
          }
          if (entryFill.commissionCurrency !== quoteCurrency || closeFill.commissionCurrency !== quoteCurrency) {
            throw new Error('Futures entry/exit commission currency does not match the realized-PnL quote currency');
          }
          exitProfitQuote = recoveredPnl.realizedProfit;
          exitProfitCurrency = String(recoveredPnl.realizedProfitCurrency);
        } else {
          if (
            entryFill.quoteCurrency !== quoteCurrency ||
            closeFill.quoteCurrency !== quoteCurrency ||
            !Number.isFinite(Number(entryFill.grossQuote)) ||
            !Number.isFinite(Number(closeFill.grossQuote)) ||
            !Number.isFinite(Number(closeFill.feeQuote)) ||
            !Number.isFinite(Number(entryFill.feeQuote))
          ) {
            throw new Error('Spot OPEN/close gross proceeds or quote-denominated fees are unavailable');
          }
          // Exit result excludes the entry fee, which is stored in realizedProfit
          // and added exactly once to the final trade result.
          exitProfitQuote = Number(closeFill.grossQuote) -
            Number(entryFill.grossQuote) -
            Number(closeFill.feeQuote);
          if (entryFill.commissionCurrency !== quoteCurrency || closeFill.commissionCurrency !== quoteCurrency) {
            throw new Error('Spot fee conversion did not produce the pair quote currency');
          }
        }

        const entryConversionRate = await this.resolveHistoricalProtectionFailureConversionRate(
          conversionScanner,
          exitProfitCurrency,
          accountCurrency,
          Number(entryFill.brokerTimestamp),
        );
        const exitConversionRate = await this.resolveHistoricalProtectionFailureConversionRate(
          conversionScanner,
          exitProfitCurrency,
          accountCurrency,
          Number(closeFill.brokerTimestamp),
        );
        const entryCommissionAccount = Number(entryFill.commission) * entryConversionRate;
        const exitProfitAccount = exitProfitQuote * exitConversionRate;
        if (
          !(entryCommissionAccount >= 0) ||
          !Number.isFinite(entryCommissionAccount) ||
          !Number.isFinite(exitProfitAccount)
        ) {
          throw new Error('Recovered entry commission or close PnL is non-finite');
        }
        const finalProfit = exitProfitAccount - entryCommissionAccount;
        if (!Number.isFinite(finalProfit)) {
          throw new Error('Emergency-close cumulative PnL is invalid');
        }

        const openedAt = Number(entryFill.brokerTimestamp) > 0
          ? Number(entryFill.brokerTimestamp)
          : Number(parent.createdAt ?? row.createdAt);
        const closedAt = Math.max(
          openedAt,
          Number(closeFill.brokerTimestamp) > 0 ? Number(closeFill.brokerTimestamp) : Date.now(),
        );
        const mlPredictionId = String(parentSignal.mlPredictionId ?? '').trim() || undefined;
        const trade = {
          ticket: entryFill.orderId,
          symbol,
          timeframe,
          side: side as 'BUY' | 'SELL',
          volume: entryFill.executedQty,
          entry: entryFill.avgPrice,
          sl: Number(signal.sl),
          tp: Number(signal.tp),
          status: 'closed' as const,
          openedAt: Math.max(1, openedAt),
          closedAt,
          profit: finalProfit,
          realizedProfit: -entryCommissionAccount,
          source: String(parentSignal.source ?? signal.source ?? 'BINANCE_PROTECTION_FAILURE'),
          exitReason: 'PROTECTION_FAILURE',
          commission: entryCommissionAccount,
          commissionCurrency: accountCurrency,
          entryQuoteToAccount: entryConversionRate,
          exitQuoteToAccount: exitConversionRate,
          account: this.config.accountName ?? 'default',
          mlPredictionId,
        };

        const tradeId = this.db.settleProtectionFailureClose({
          parentExecutionId: String(parent.executionId),
          parentOperationKey,
          parentBrokerOrderId: entryFill.orderId,
          parentResult: {
            broker: 'binance',
            symbol,
            clientOrderId: expectedParentClientId,
            orderId: entryFill.orderId,
            executedQty: entryFill.executedQty,
            entryPrice: entryFill.avgPrice,
            entryCommission: entryFill.commission,
            entryCommissionCurrency: entryFill.commissionCurrency,
            accountCurrency,
            entryConversionRate,
            exitConversionRate,
          },
          childExecutionId: String(row.executionId),
          childOperationKey,
          childBrokerOrderId: closeFill.orderId,
          childResult: {
            broker: 'binance',
            symbol,
            clientOrderId: expectedEmergencyClientId,
            orderId: closeFill.orderId,
            status: 'FILLED',
            executedQty: closeFill.executedQty,
            exitPrice: closeFill.avgPrice,
            exitCommission: closeFill.commission,
            exitCommissionCurrency: closeFill.commissionCurrency,
            exitProfitQuote,
            exitProfitCurrency,
            exitProfitAccount,
            entryConversionRate,
            exitConversionRate,
            positionBeforeSigned,
            positionAfterSigned: actualSignedAfter,
            positionDeltaVerified: true,
            parentOperationKey,
          },
          exitProfitAccount,
          trade,
        });
        if (!tradeId) {
          throw new Error('Atomic emergency-close settlement declined the parent/child ledger pair');
        }

        this.logger.info(
          '[Binance] startup-settled protection-failure emergency close trade=' +
          tradeId + ' symbol=' + symbol + ' net=' + finalProfit,
        );
      } catch (e: any) {
        const message = String(e?.message ?? e).slice(0, 1000);
        this.db.updateExecutionLedger(String(row.executionId), {
          status: 'UNKNOWN',
          error: 'Protection-failure startup recovery blocked: ' + message,
        });
        this.logger.error(
          '[Binance] protection-failure emergency close remains UNKNOWN: ' +
          String(row.operationKey) + ' ' + message,
        );
      }
    }
  }

  private async blockOrphanedBinanceOpenIntents(
    exec: BinanceExecutor,
  ): Promise<void> {
    const rows = this.db.raw().prepare(`
      SELECT executionId, operationKey, symbol, side, volume, requestJson, status, createdAt
      FROM execution_ledger
      WHERE status IN ('PENDING', 'UNKNOWN')
        AND action='OPEN'
      ORDER BY createdAt ASC, updatedAt ASC, executionId ASC
    `).all() as Array<{
      executionId: string;
      operationKey: string;
      symbol?: string | null;
      side?: string | null;
      volume?: number | null;
      requestJson?: string | null;
      status: string;
      createdAt: number;
    }>;

    for (const row of rows) {
      const operationKey = String(row.operationKey ?? '').trim();
      const childOperationKey = `PROTECTION_FAIL:${operationKey}`;
      const child = operationKey
        ? this.db.getExecutionByOperationKey(childOperationKey)
        : null;

      // The emergency-child resolver above owns these records. If the child
      // remains unresolved it already blocks startup; do not reinterpret it
      // as a missing-child incident.
      if (child && ['PENDING', 'UNKNOWN'].includes(String(child.status))) {
        continue;
      }

      let request: any = null;
      let requestError: string | null = null;
      try {
        request = JSON.parse(String(row.requestJson ?? 'null'));
      } catch (error: any) {
        requestError = String(error?.message ?? error);
      }

      const symbol = String(
        row.symbol ?? request?.signal?.symbol ?? '',
      ).trim().toUpperCase();
      let exactOrder: any = null;
      let lookupError: string | null = null;
      let clientOrderId = '';
      if (operationKey && symbol) {
        try {
          clientOrderId = exec.clientOrderIdForOperationKey(operationKey);
          exactOrder = await exec.recoverOperationOrderForReconciliation(
            symbol,
            operationKey,
          );
        } catch (error: any) {
          lookupError = String(error?.message ?? error).slice(0, 500);
        }
      } else {
        lookupError = 'OPEN ledger is missing a valid operation key or symbol';
      }

      const brokerEvidence = exactOrder
        ? {
            found: true,
            symbol: String(exactOrder.symbol ?? symbol).toUpperCase(),
            clientOrderId: String(
              exactOrder.clientOrderId ?? exactOrder.origClientOrderId ?? '',
            ),
            orderId: Number(exactOrder.orderId),
            status: String(exactOrder.status ?? 'UNKNOWN').toUpperCase(),
            origQty: Number.isFinite(Number(exactOrder.origQty))
              ? Number(exactOrder.origQty)
              : null,
            executedQty: Number.isFinite(Number(exactOrder.executedQty))
              ? Number(exactOrder.executedQty)
              : null,
            updateTime: Number.isFinite(Number(exactOrder.updateTime))
              ? Number(exactOrder.updateTime)
              : null,
          }
        : {
            found: false,
            clientOrderId: clientOrderId || null,
            lookupError,
          };

      const reason =
        `ORPHANED_BINANCE_OPEN operationKey=${operationKey || 'MISSING'} ` +
        `executionId=${row.executionId} status=${row.status} childOperationKey=${childOperationKey}. ` +
        `Exact broker lookup=${exactOrder ? 'found' : 'not-confirmed'}; ` +
        `lookupError=${lookupError ?? 'none'}. The process may have stopped after entry submission/fill ` +
        `but before protection and trade-ledger settlement completed. Startup is blocked: verify broker ` +
        `exposure and operation-owned protection orders manually. Do not retry the entry or send a close ` +
        `until the exact broker state is proven.`;

      this.record(
        'BLOCKED',
        symbol || null,
        {
          incidentType: 'ORPHANED_BINANCE_OPEN',
          executionId: row.executionId,
          operationKey,
          childOperationKey,
          childStatus: child?.status ?? null,
          requestError,
          requestedSide: String(row.side ?? request?.signal?.side ?? ''),
          requestedVolume: Number(row.volume ?? request?.volume ?? 0),
          brokerEvidence,
        },
        reason,
      );
      throw new Error(`[Reconciliation] ${reason}`);
    }
  }

  private async reconcileBinance(): Promise<unknown> {
    const exec = new BinanceExecutor(this.config);
    if (!(await exec.ping())) throw new Error('Binance connectivity/position-mode validation failed');
    await this.resolveProtectionFailureEmergencyCloseLedgers(exec);
    await this.blockOrphanedBinanceOpenIntents(exec);

    // Spot has no broker ticket/position identity. Startup therefore requires
    // exact operation-keyed OCO protection for every local open trade plus
    // aggregate inventory consistent with local quantities.
    if (!this.config.binance.futures) {
      const openTrades = this.db.getOpenTrades();
      const balances = await exec.getAllSpotBalancesForConfiguredSymbols();

      const byAsset = new Map(
        (balances as any[]).map(balance => [
          String(balance.asset).toUpperCase(),
          Number(balance.free) + Number(balance.locked),
        ]),
      );
      const expectedByBase = new Map<string, number>();

      for (const t of openTrades) {
        const raw = String(t.symbol).trim().toUpperCase();
        const quote = ['USDT', 'USDC', 'BUSD'].find(q => raw.endsWith(q));
        if (!quote) {
          throw new Error(
            `Unsupported Binance Spot quote asset for ${raw}; manual reconciliation is required.`,
          );
        }
        const base = raw.slice(0, -quote.length);
        expectedByBase.set(
          base,
          (expectedByBase.get(base) ?? 0) + Number(t.volume),
        );

        const openOperation =
          this.db.getLatestExecutedOpenOperationForTrade(t.id);
        if (!openOperation || openOperation.conflict) {
          throw new Error(
            openOperation?.conflict
              ? `Conflicting Binance Spot OPEN operation identities for trade id=${t.id}; manual reconciliation is required.`
              : `Binance Spot trade id=${t.id} lacks an authoritative OPEN operation key; manual reconciliation is required.`,
          );
        }

        const operationKey = String(openOperation.operationKey);


        const list = await exec.recoverSpotOcoByOperation(
          t.symbol,
          operationKey,
        );
        if (!list) {
          throw new Error(
            `Binance Spot OCO could not be recovered for trade id=${t.id} symbol=${t.symbol}`,
          );
        }

        const status = String(list.listStatusType).toUpperCase();
        const listStatus = String(list.listOrderStatus).toUpperCase();
        if (
          !['EXEC_STARTED', 'EXECUTING'].includes(status) &&
          !['EXECUTING'].includes(listStatus)
        ) {
          throw new Error(
            `Binance Spot OCO is not active for trade id=${t.id}: ${status}/${listStatus}`,
          );
        }

        const listOrders = Array.isArray(list.orders) ? list.orders : [];
        if (listOrders.length !== 2) {
          throw new Error(
            `Binance Spot OCO has invalid leg count for trade id=${t.id}`,
          );
        }

        const openOrders = await exec.getOpenOrders(t.symbol);
        const byId = new Map(
          openOrders.map((order: any) => [Number(order.orderId), order]),
        );
        const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';
        const tpTolerance = Math.max(1e-8, Math.abs(t.tp) * 1e-6);
        const slTolerance = Math.max(1e-8, Math.abs(t.sl) * 1e-6);
        const liveLegs = listOrders
          .map((order: any) => byId.get(Number(order.orderId)))
          .filter(Boolean);
        if (liveLegs.length !== 2) {
          throw new Error(
            `Binance Spot OCO legs are not both open for trade id=${t.id}`,
          );
        }
        const tp = liveLegs.find((order: any) =>
          String(order.side).toUpperCase() === closeSide &&
          String(order.type).toUpperCase().includes('LIMIT') &&
          String(order.status).toUpperCase() === 'NEW' &&
          Math.abs(Number(order.price) - Number(t.tp)) <= tpTolerance,
        );
        const sl = liveLegs.find((order: any) =>
          String(order.side).toUpperCase() === closeSide &&
          String(order.type).toUpperCase().includes('STOP') &&
          String(order.status).toUpperCase() === 'NEW' &&
          Math.abs(Number(order.stopPrice) - Number(t.sl)) <= slTolerance,
        );
        if (!tp || !sl) {
          throw new Error(
            `Binance Spot OCO prices/side do not match trade id=${t.id}`,
          );
        }
      }

      for (const [base, expected] of expectedByBase) {
        if (!(expected > 0) || !Number.isFinite(expected)) {
          throw new Error(`Invalid local Spot inventory expectation for ${base}`);
        }
        const inventory = Number(byAsset.get(base) ?? 0);
        const tolerance = Math.max(1e-8, expected * 0.0001);
        if (!Number.isFinite(inventory) || Math.abs(inventory - expected) > tolerance) {
          throw new Error(
            `Binance Spot inventory mismatch for ${base}: local=${expected} broker=${inventory}; manual reconciliation is required.`,
          );
        }
      }

      if (openTrades.length === 0) {
        for (const symbol of this.config.symbols ?? []) {
          const raw = String(symbol).trim().toUpperCase();
          const quote = ['USDT', 'USDC', 'BUSD'].find(q => raw.endsWith(q));
          if (!quote) continue;
          const base = raw.slice(0, -quote.length);
          const inventory = Number(byAsset.get(base) ?? 0);
          if (Number.isFinite(inventory) && inventory > 1e-8) {
            throw new Error(
              `Binance Spot startup found non-zero ${base} inventory for ${raw} without an attributable open bot trade; manual reconciliation is required.`,
            );
          }
        }
      }

      return balances;
    }

    const initialPositions = await exec.getAllPositions();
    await this.resolveAuthoritativeBinanceModifyLedgers(exec, initialPositions);
    await this.resolveAuthoritativeBinanceLedgers(exec, initialPositions);

    // Recovery can settle a close or replace protective orders. Re-read live
    // exposure after those operations so startup never validates a stale snapshot.
    const positions = await exec.getAllPositions();
    const openTrades = this.db.getOpenTrades();
    const bySymbol = new Map<string, any>(
      positions.map(p => [p.symbol, p]),
    );
    for (const p of positions) {
      if (Math.abs(p.positionAmt) > 0) bySymbol.set(p.symbol, p);
    }

    for (const t of openTrades) {
      const p = bySymbol.get(t.symbol);
      if (!p) throw new Error(`Binance position missing for DB trade id=${t.id} symbol=${t.symbol}; realized PnL cannot be inferred safely`);
      const brokerSide = p.positionAmt > 0 ? 'BUY' : 'SELL';
      if (brokerSide !== t.side) throw new Error(`Binance side mismatch ${t.symbol}: DB=${t.side} broker=${brokerSide}`);
      const volume = Math.abs(p.positionAmt);
      if (Math.abs(volume - t.volume) > Math.max(1e-12, t.volume * 0.02))
        throw new Error(`Binance volume mismatch ${t.symbol}: DB=${t.volume} broker=${volume}`);
      if (!(p.entryPrice > 0)) throw new Error(`Binance entry price invalid for ${t.symbol}`);

      const openOperation = this.db.getLatestExecutedOpenOperationForTrade(t.id);
      if (!openOperation || openOperation.conflict) {
        throw new Error(
          openOperation?.conflict
            ? `Conflicting Binance Futures OPEN identities for trade id=${t.id}; manual reconciliation is required.`
            : `Binance Futures trade id=${t.id} lacks an authoritative OPEN operation key.`,
        );
      }
      let latestMoveOperation: {
        operationKey: string;
        request: any;
      } | null = null;
      const moveRows = this.db.raw().prepare(`
        SELECT operationKey, requestJson, tradeId, status
        FROM execution_ledger
        WHERE action='MOVE_SL_TP'
          AND status IN ('EXECUTED','FAILED')
          AND (tradeId=? OR tradeId IS NULL)
        ORDER BY updatedAt DESC, executionId DESC
        LIMIT 100
      `).all(t.id) as Array<{
        operationKey: string;
        requestJson?: string | null;
        tradeId?: number | null;
        status?: string;
      }>;
      for (const row of moveRows) {
        try {
          const moveRequest = JSON.parse(String(row.requestJson ?? 'null'));
          if (
            Number(row.tradeId ?? moveRequest?.tradeId) === Number(t.id) &&
            Number(moveRequest?.tradeId) === Number(t.id)
          ) {
            if (
              row.status === 'FAILED' &&
              ['RESTORE_VERIFIED', 'OLD_PAIR_RETAINED'].includes(String(moveRequest?.phase ?? ''))
            ) {
              const activeKey = String(moveRequest?.activeProtectionKey ?? '').trim();
              const oldProtection = moveRequest?.oldProtection ?? {};
              const activeSl = Number(oldProtection.slPrice);
              const activeTp = Number(oldProtection.tpPrice);
              if (
                !activeKey ||
                !(activeSl > 0) || !(activeTp > 0) ||
                !Number.isFinite(activeSl) || !Number.isFinite(activeTp)
              ) {
                throw new Error(`Failed Binance protection modification has incomplete active protection metadata for trade id=${t.id}`);
              }
              latestMoveOperation = {
                operationKey: activeKey,
                request: { ...moveRequest, newSl: activeSl, newTp: activeTp },
              };
            } else if (row.status === 'EXECUTED') {
              latestMoveOperation = {
                operationKey: String(row.operationKey),
                request: moveRequest,
              };
            } else {
              continue;
            }
            break;
          }
        } catch {
          // A malformed modification request cannot be used as protection identity.
        }
      }

      const operationKey = latestMoveOperation?.operationKey ??
        String(openOperation.operationKey);
      const expectedSl = latestMoveOperation
        ? Number(latestMoveOperation.request.newSl)
        : Number(t.sl);
      const expectedTp = latestMoveOperation
        ? Number(latestMoveOperation.request.newTp)
        : Number(t.tp);
      const tolerance = (target: number) => Math.max(1e-8, Math.abs(target) * 1e-6);
      if (
        !(expectedSl > 0) ||
        !(expectedTp > 0) ||
        !Number.isFinite(expectedSl) ||
        !Number.isFinite(expectedTp) ||
        (latestMoveOperation &&
          (Math.abs(Number(t.sl) - expectedSl) > tolerance(expectedSl) ||
           Math.abs(Number(t.tp) - expectedTp) > tolerance(expectedTp)))
      ) {
        throw new Error(
          `Binance Futures trade id=${t.id} has inconsistent persisted protection targets; manual reconciliation is required.`,
        );
      }

      const recoveredProtection = await exec.recoverProtectionByOperation(
        t.symbol,
        operationKey,
      );
      const openOrders = await exec.getOpenAlgoOrders(t.symbol);
      const byId = new Map(
        openOrders.map((order: any) => [Number(order.orderId), order]),
      );
      const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';
      const slId = Number(recoveredProtection.sl?.orderId ?? 0);
      const tpId = Number(recoveredProtection.tp?.orderId ?? 0);
      const sl = byId.get(slId) as any;
      const tp = byId.get(tpId) as any;
      const exactProtectionValid =
        slId > 0 &&
        tpId > 0 &&
        slId !== tpId &&
        !!sl &&
        !!tp &&
        String(sl.clientOrderId ?? '') === String(recoveredProtection.sl?.clientOrderId ?? '') &&
        String(tp.clientOrderId ?? '') === String(recoveredProtection.tp?.clientOrderId ?? '') &&
        String(sl.side ?? '').toUpperCase() === closeSide &&
        String(tp.side ?? '').toUpperCase() === closeSide &&
        String(sl.type ?? '').toUpperCase() === 'STOP_MARKET' &&
        String(tp.type ?? '').toUpperCase() === 'TAKE_PROFIT_MARKET' &&
        String(sl.status ?? '').toUpperCase() === 'NEW' &&
        String(tp.status ?? '').toUpperCase() === 'NEW' &&
        String(sl.closePosition).toLowerCase() === 'true' &&
        String(tp.closePosition).toLowerCase() === 'true';
      const slOk =
        exactProtectionValid &&
        Number.isFinite(Number(sl.stopPrice)) &&
        Math.abs(Number(sl.stopPrice) - expectedSl) <= tolerance(expectedSl);
      const tpOk =
        exactProtectionValid &&
        Number.isFinite(Number(tp.stopPrice)) &&
        Math.abs(Number(tp.stopPrice) - expectedTp) <= tolerance(expectedTp);
      if (!slOk || !tpOk) {
        throw new Error(
          `Binance Futures operation-keyed Algo protection missing/mismatched for trade id=${t.id} symbol=${t.symbol}`,
        );
      }
      const additionalPositionClosingAlgos = openOrders.filter((order: any) =>
        Number(order.orderId) !== slId &&
        Number(order.orderId) !== tpId &&
        String(order.side ?? '').toUpperCase() === closeSide &&
        String(order.closePosition).toLowerCase() === 'true' &&
        ['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(String(order.type ?? '').toUpperCase()),
      );
      if (additionalPositionClosingAlgos.length > 0) {
        throw new Error(
          `Unattributed Binance Futures position-closing Algo orders exist for ${t.symbol}; startup requires manual reconciliation.`,
        );
      }
      if (
        (t.side === 'BUY' && !(t.sl < p.entryPrice && t.tp > p.entryPrice)) ||
        (t.side === 'SELL' && !(t.sl > p.entryPrice && t.tp < p.entryPrice))
      ) {
        throw new Error(`Binance protective order direction invalid for ${t.symbol}`);
      }
    }

    for (const [symbol] of bySymbol) {
      if (!openTrades.some(t => t.symbol === symbol && t.status === 'open'))
        throw new Error(`Hidden Binance position detected for ${symbol} without internal ledger`);
    }
    return positions;
  }

  private record(status: string, symbol: string | null, broker: unknown, reason: string) {
    try {
      this.db.raw().prepare(`
        INSERT INTO reconciliation_events(symbol,account,status,internalJson,brokerJson,reason,timestamp)
        VALUES (?,?,?,?,?,?,?)
      `).run(symbol, this.config.accountName ?? 'default', status, JSON.stringify(this.db.getOpenTrades()), JSON.stringify(broker), reason, Date.now());
    } catch (e) {
      this.logger.error(`Failed to persist reconciliation event: ${String(e)}`);
    }
  }
}

