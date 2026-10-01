import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { BinanceExecutor } from '../execution/BinanceExecutor';
import { TelegramBot } from '../notifications/TelegramBot';
import { Logger } from '../utils/Logger';

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

      const resolved = this.db.resolveReconciledFullClose(
        Number(trade.id),
        String(row.executionId),
        history.profit,
        Date.now(),
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
  private async reconcileBinance(): Promise<unknown> {
    const exec = new BinanceExecutor(this.config);
    if (!(await exec.ping())) throw new Error('Binance connectivity/position-mode validation failed');

    // Futures exposes position identity directly. Spot does not: an asset
    // balance has no built-in link to a bot ticket and may include holdings
    // that predate the bot. Never pretend that a raw Spot balance proves which
    // trade owns the units.
    if (!this.config.binance.futures) {
      const openTrades = this.db.getOpenTrades();
      if (openTrades.length > 0) {
        throw new Error(
          'Binance Spot restart reconciliation is ambiguous for open bot trades: ' +
          'Spot balances do not preserve per-trade ownership. Manual reconciliation is required.',
        );
      }

      const balances = await exec.getAllSpotBalancesForConfiguredSymbols();
      const byAsset = new Map(
        (balances as any[]).map(balance => [
          String(balance.asset).toUpperCase(),
          Number(balance.free) + Number(balance.locked),
        ]),
      );

      for (const symbol of this.config.symbols ?? []) {
        const raw = String(symbol).trim().toUpperCase();
        const quote = ['USDT', 'USDC', 'BUSD'].find(q => raw.endsWith(q));
        if (!quote) continue;
        const base = raw.slice(0, -quote.length);
        const inventory = Number(byAsset.get(base) ?? 0);
        if (Number.isFinite(inventory) && inventory > 1e-8) {
          throw new Error(
            `Binance Spot startup found non-zero ${base} inventory for ${raw} ` +
            'without an attributable open bot trade; manual reconciliation is required.',
          );
        }
      }

      return balances;
    }

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

      const openOrders = await exec.getOpenOrders(t.symbol);
      const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';
      const matching = openOrders.filter((o: any) => String(o.side).toUpperCase() === closeSide);
      const stopOrders = matching.filter((o: any) => /STOP_LOSS|STOP_MARKET/.test(String(o.type ?? '').toUpperCase()));
      const takeOrders = matching.filter((o: any) => /TAKE_PROFIT|LIMIT_MAKER/.test(String(o.type ?? '').toUpperCase()));
      const slOk = stopOrders.some((o: any) => Number.isFinite(Number(o.stopPrice)) && Math.abs(Number(o.stopPrice) - t.sl) <= Math.max(1e-8, t.sl * 0.001));
      const tpOk = takeOrders.some((o: any) => {
        const p0 = Number(o.price);
        const sp = Number(o.stopPrice);
        return (Number.isFinite(p0) && Math.abs(p0 - t.tp) <= Math.max(1e-8, t.tp * 0.001)) ||
               (Number.isFinite(sp) && Math.abs(sp - t.tp) <= Math.max(1e-8, t.tp * 0.001));
      });
      if (!slOk || !tpOk) throw new Error(`Binance protective orders missing/mismatched for ${t.symbol}`);
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
