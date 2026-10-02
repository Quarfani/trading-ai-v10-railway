import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { BinanceExecutor } from '../execution/BinanceExecutor';
import { TelegramBot } from '../notifications/TelegramBot';
import { Logger } from '../utils/Logger';
import { MarketScanner } from '../core/MarketScanner';
import { CurrencyConversionProvider } from '../market/CurrencyConversionProvider';

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

  private async reconcileBinance(): Promise<unknown> {
    const exec = new BinanceExecutor(this.config);
    if (!(await exec.ping())) throw new Error('Binance connectivity/position-mode validation failed');

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


        const list = await exec.recoverBinanceSpotOco(
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

        const openOrders = await exec.getBinanceOpenOrders(t.symbol);
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

    const positions = await exec.getAllPositions();
    await this.resolveAuthoritativeBinanceModifyLedgers(exec, positions);
    await this.resolveAuthoritativeBinanceLedgers(exec, positions);
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

      const openOrders = await exec.getOpenOrders(t.symbol);
      const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';
      const matching = openOrders.filter((o: any) => String(o.side).toUpperCase() === closeSide);
      const tolerance = (target: number) => Math.max(1e-8, Math.abs(target) * 1e-6);
      const stopOrders = matching.filter((o: any) =>
        String(o.type ?? '').toUpperCase() === 'STOP_MARKET' &&
        String(o.closePosition).toLowerCase() === 'true',
      );
      const takeOrders = matching.filter((o: any) =>
        String(o.type ?? '').toUpperCase() === 'TAKE_PROFIT_MARKET' &&
        String(o.closePosition).toLowerCase() === 'true',
      );
      const slOk = stopOrders.some((o: any) =>
        Number.isFinite(Number(o.stopPrice)) &&
        Math.abs(Number(o.stopPrice) - t.sl) <= tolerance(t.sl),
      );
      const tpOk = takeOrders.some((o: any) =>
        Number.isFinite(Number(o.stopPrice)) &&
        Math.abs(Number(o.stopPrice) - t.tp) <= tolerance(t.tp),
      );
      if (!slOk || !tpOk) throw new Error(`Binance protective orders missing/mismatched for ${t.symbol}`);
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
