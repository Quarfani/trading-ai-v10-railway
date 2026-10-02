/**
 * RECONCILER — v9.1
 * ════════════════════════════════════════════════════════════════════
 * [FIX] يتعامل مع Partial Closes بشكل صحيح
 * [FIX] MT5: يُقارن فعلياً بـ open positions (لا closed orders)
 * [FIX] Binance: يتحقق من position size
 * [FIX] يُطلق onClose callback مع exitPrice الفعلي
 * [FIX v9.1] Paper/Binance reconcile كانت تُجبر 'M1' على جميع الصفقات.
 *            الآن تستخدم الـ timeframe الفعلي للصفقة (مخزون في t.timeframe).
 *            هذا يمنع اصطياد SL/TP وهمي بسبب ضوضاء دقيقة في صفقات H4.
 * ════════════════════════════════════════════════════════════════════
 */
import axios                           from 'axios';
import { SystemConfig, Trade }         from '../types/trading.types';
import { DatabaseManager }             from '../database/DatabaseManager';
import { ExecutionGateway }            from '../execution/ExecutionGateway';
import { TelegramBot }                 from '../notifications/TelegramBot';
import { PerformanceTracker }          from '../analytics/PerformanceTracker';
import { MarketScanner }               from './MarketScanner';
import { Logger }                      from '../utils/Logger';
import { EmergencyStop }               from '../integration/EmergencyStop';

type ClosedCallback = (trade: Trade & { exitPrice?: number }) => void;

/**
 * Map the trade's timeframe string to the scanner's Timeframe type.
 * Falls back to 'M5' which is a safe minimum — fine-grained enough
 * to detect SL/TP hits without the noise of M1.
 */
function tradeTimeframe(t: Trade): string {
  // t.timeframe is the TF the signal came from (e.g. 'H4', 'H1', 'M15')
  return (t as any).timeframe ?? 'M5';
}

/** How many candles to fetch when checking for SL/TP hits. */
const CHECK_CANDLES = 3;

export class Reconciler {
  private logger   = new Logger('Reconciler');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private config:    SystemConfig,
    private db:        DatabaseManager,
    private exec:      ExecutionGateway,
    private telegram:  TelegramBot,
    private tracker:   PerformanceTracker,
    private scanner:   MarketScanner,
    private emergency: EmergencyStop,
    private onClose:   ClosedCallback,
  ) {}

  start(): void {
    if (!this.interval)
      this.interval = setInterval(() => this.tick().catch(() => {}), 10_000);
    this.logger.info('Reconciler started (10s interval)');
  }

  async reconcileNow(): Promise<{ checked: number; failures: number }> {
    const open = this.db.getOpenTrades();
    let failures = 0;

    for (const t of open) {
      try {
        await this.reconcileOne(t);
      } catch (e: any) {
        failures++;
        const message = `Startup reconciliation failure for ${t.symbol}: ${e?.message ?? e}`;
        this.logger.error(message);
        if (this.config.mode !== 'paper') {
          await this.emergency.activate(message);
        }
      }
    }

    if (failures > 0) {
      throw new Error(`Startup reconciliation failed for ${failures}/${open.length} open trade(s)`);
    }

    return { checked: open.length, failures };
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async tick(): Promise<void> {
    const open = this.db.getOpenTrades();
    if (!open.length) return;

    for (const t of open) {
      try {
        await this.reconcileOne(t);
      } catch (e: any) {
        const message = `Reconciliation failure for ${t.symbol}: ${e?.message ?? e}`;
        this.logger.error(message);
        if (this.config.mode !== 'paper') await this.emergency.activate(message);
      }
    }
  }

  private async reconcileOne(t: Trade): Promise<void> {
    const mode = this.config.mode;

    if      (mode === 'paper')   await this.reconcilePaper(t);
    else if (mode === 'mt5')     await this.reconcileMT5(t);
    else if (mode === 'binance') await this.reconcileBinance(t);
  }

  // ─── Paper ──────────────────────────────────────────────────────────

  private async reconcilePaper(t: Trade): Promise<void> {
    // FIX: was 'M1' as any for every trade regardless of its timeframe.
    // An H4 trade should be checked on its own timeframe; M1 noise can
    // trigger false SL/TP hits on wide-stop trades like XAUUSD or BTC.
    const tf = tradeTimeframe(t);
    const candles = await this.scanner
      .fetchCandles(t.symbol, tf as any, CHECK_CANDLES)
      .catch(() => []);
    if (!candles.length) return;

    // Use the last complete candle's OHLC for a realistic hit-check
    const last = candles[candles.length - 1];

    const hitSL = t.side === 'BUY' ? last.low  <= t.sl : last.high >= t.sl;
    const hitTP = t.side === 'BUY' ? last.high >= t.tp : last.low  <= t.tp;

    if (hitSL || hitTP) {
      // Use the actual SL/TP price as exit, not the candle close
      const exitPrice  = hitSL ? t.sl : t.tp;
      const exitReason = hitSL ? 'SL' : 'TP';
      await this.closeAndRecord(t, exitPrice, exitReason);
    }
  }

  // ─── MT5 ────────────────────────────────────────────────────────────

  private async reconcileMT5(t: Trade): Promise<void> {
    if (!t.ticket) return;
      const r = await axios.get(
        `${this.config.mt5.bridgeUrl}/positions`,
        {
          timeout: 5_000,
          headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey },
        },
      );
      if (r.data?.ok === false) {
        throw new Error('MT5 positions failed: ' + (r.data?.error ?? 'unknown error'));
      }
      const positions: any[] = r.data?.positions ?? [];
      const live = positions.find(
        (p: any) => Number(p.ticket) === Number(t.ticket),
      );

      if (!live) {
        // Position closed on broker side
        const hist = await this.getMT5History(t.ticket);
        if (!hist) throw new Error(`MT5 position ${t.ticket} is absent but authoritative close history is unavailable`);
        if (!this.reconcileFullCloseAtomically(t, hist)) {
          await this.closeAndRecord(t, hist.price, hist.reason, hist.profit);
          this.resolveReconciledLedger(
            t.id,
            ['CLOSE', 'CLOSE_AT_MARKET'],
            {
              broker: 'mt5',
              ticket: t.ticket,
              profit: hist.profit,
              reason: hist.reason,
              closePrice: hist.price,
            },
          );
        }
      } else {
        // Verify and recover MT5 protective-order state before processing
        // partial-close changes. A broker-side SL/TP change that was not
        // persisted locally must be reconciled atomically; an unexplained
        // mismatch is never silently accepted.
        const unresolvedModify = t.id
          ? this.db.getLatestUnresolvedExecutionForTrade(t.id, ['MOVE_SL_TP'])
          : null;
        if (unresolvedModify) {
          if (!this.reconcileMT5Modify(t, live, unresolvedModify)) {
            throw new Error(
              `MT5 protective-order state for unresolved MOVE_SL_TP is not provably safe for ticket=${t.ticket}`,
            );
          }
        }

        const sl = Number(live.sl);
        const tp = Number(live.tp);
        if (
          !Number.isFinite(sl) ||
          !Number.isFinite(tp) ||
          sl <= 0 ||
          tp <= 0
        ) {
          throw new Error(
            'MT5 invalid protective-order state ticket=' + t.ticket,
          );
        }
        if (
          (t.side === 'BUY' && !(sl < t.entry && tp > t.entry)) ||
          (t.side === 'SELL' && !(sl > t.entry && tp < t.entry))
        ) {
          throw new Error(
            'MT5 protective-order direction invalid ticket=' + t.ticket,
          );
        }
        const slTolerance = Math.max(1e-8, Math.abs(t.sl) * 1e-6);
        const tpTolerance = Math.max(1e-8, Math.abs(t.tp) * 1e-6);
        if (
          Math.abs(sl - t.sl) > slTolerance ||
          Math.abs(tp - t.tp) > tpTolerance
        ) {
          throw new Error(
            `MT5 protective-order mismatch ticket=${t.ticket}: DB SL/TP=${t.sl}/${t.tp} broker=${sl}/${tp}`,
          );
        }

        // Handle partial close: volume reduced on broker side
        const brokerVolume = Number(live.volume);
        if (!Number.isFinite(brokerVolume) || brokerVolume <= 0) {
          throw new Error('MT5 invalid broker volume ticket=' + t.ticket);
        }
        const volumeDelta = t.volume - brokerVolume;
        if (volumeDelta > Math.max(1e-8, t.volume * 0.0001)) {
          this.logger.info(
            `[${t.symbol}] Partial close detected: ${volumeDelta.toFixed(8)} lots closed`,
          );

          const cumulative = await this.getMT5History(t.ticket, false);
          const currentRealized = Number(t.realizedProfit ?? 0);
          const cumulativeRealized = cumulative
            ? Number(cumulative.profit)
            : Number.NaN;

          let reconciledAtomically = false;
          if (Number.isFinite(cumulativeRealized)) {
            reconciledAtomically = this.reconcilePartialCloseAtomically(
              t,
              brokerVolume,
              cumulativeRealized,
              {
                broker: 'mt5',
                ticket: t.ticket,
                closedVolume: volumeDelta,
                remainingVolume: brokerVolume,
                cumulativeRealizedProfit: cumulativeRealized,
              },
            );
          }
          if (!reconciledAtomically) {
            if (Number.isFinite(cumulativeRealized)) {
              this.db.raw()
                .prepare(
                  'UPDATE trades SET volume=?, realizedProfit=? WHERE id=? AND status=\'open\'',
                )
                .run(
                  brokerVolume,
                  cumulativeRealized,
                  t.id!,
                );
            } else {
              this.db.raw()
                .prepare('UPDATE trades SET volume=? WHERE id=? AND status=\'open\'')
                .run(brokerVolume, t.id!);
            }
          }

          if (
            Number.isFinite(cumulativeRealized) &&
            Math.abs(cumulativeRealized - currentRealized) > 1e-8
          ) {
            this.logger.info(
              `[${t.symbol}] Reconciled cumulative realized PnL=${cumulativeRealized.toFixed(8)}`,
            );
          }

          if (!reconciledAtomically && Number.isFinite(cumulativeRealized)) {
            this.resolveReconciledLedger(
              t.id,
              ['PARTIAL_CLOSE'],
              {
                broker: 'mt5',
                ticket: t.ticket,
                closedVolume: volumeDelta,
                remainingVolume: brokerVolume,
                cumulativeRealizedProfit: cumulativeRealized,
              },
            );
          }
        }
      }
  }

  private reconcileMT5Modify(
    t: Trade,
    live: any,
    operation: any,
  ): boolean {
    if (!t.id) return false;
    const sl = Number(live?.sl);
    const tp = Number(live?.tp);
    if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl <= 0 || tp <= 0) {
      return false;
    }

    let request: any;
    try {
      request = operation.requestJson
        ? JSON.parse(operation.requestJson)
        : null;
    } catch {
      return false;
    }
    const newSl = Number(request?.newSl);
    const newTp = Number(request?.newTp);
    if (!Number.isFinite(newSl) || !Number.isFinite(newTp) || newSl <= 0 || newTp <= 0) {
      return false;
    }

    const slTolerance = Math.max(1e-8, Math.abs(newSl) * 1e-6);
    const tpTolerance = Math.max(1e-8, Math.abs(newTp) * 1e-6);
    if (
      Math.abs(sl - newSl) > slTolerance ||
      Math.abs(tp - newTp) > tpTolerance
    ) {
      return false;
    }

    if (
      (t.side === 'BUY' && !(newSl < t.entry && newTp > t.entry)) ||
      (t.side === 'SELL' && !(newSl > t.entry && newTp < t.entry))
    ) {
      return false;
    }

    const resolved = this.db.resolveReconciledSLTP(
      t.id,
      String(operation.executionId),
      newSl,
      newTp,
      {
        broker: 'mt5',
        ticket: t.ticket,
        newSl,
        newTp,
        reconciliation: true,
      },
      t.ticket,
    );
    if (!resolved) return false;

    (t as any).sl = newSl;
    (t as any).tp = newTp;
    this.logger.info(
      `[${operation.action}] reconciled MT5 protective orders operation=${operation.operationKey}`,
    );
    return true;
  }

  private async getMT5History(
    ticket: number,
    requireClosed = true,
  ): Promise<{
    price: number;
    profit: number;
    reason: string;
    closed?: boolean;
  } | null> {
    try {
      const r = await axios.get(
        `${this.config.mt5.bridgeUrl}/history`,
        {
          params: { position: ticket },
          timeout: 5_000,
          headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey },
        },
      );
      if (r.data?.ok === false) return null;

      const closed = r.data?.closed === true ||
        Number(r.data?.remaining_volume ?? 0) <= 1e-10;
      if (requireClosed && !closed) return null;

      const netProfit = Number(r.data?.net_profit);
      const price = Number(r.data?.close_price);
      if (!Number.isFinite(netProfit) || !Number.isFinite(price)) return null;

      const reason = String(r.data?.close_reason ?? 'manual').toLowerCase();
      return {
        price,
        profit: netProfit,
        reason: reason.includes('sl') ? 'SL'
              : reason.includes('tp') ? 'TP'
              : 'manual',
        closed:
          r.data?.closed === true ||
          Number(r.data?.remaining_volume ?? 0) <= 1e-10,
      };
    } catch (e) {
      throw new Error(`MT5 history lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private reconcileFullCloseAtomically(
    t: Trade,
    hist: { price: number; profit: number; reason: string },
  ): boolean {
    const operation = t.id
      ? this.db.getLatestUnresolvedExecutionForTrade(
          t.id,
          ['CLOSE', 'CLOSE_AT_MARKET'],
        )
      : null;
    if (!operation || !t.id) return false;

    const resolved = this.db.resolveReconciledFullClose(
      t.id,
      String(operation.executionId),
      hist.profit,
      Date.now(),
      hist.reason,
      {
        broker: 'mt5',
        ticket: t.ticket,
        profit: hist.profit,
        reason: hist.reason,
        closePrice: hist.price,
      },
      t.ticket,
    );
    if (!resolved) return false;

    this.recordReconciledClose(t, hist.price, hist.reason, hist.profit);
    this.logger.info(
      `[${operation.action}] atomically reconciled execution-ledger operation=${operation.operationKey}`,
    );
    return true;
  }

  private reconcilePartialCloseAtomically(
    t: Trade,
    brokerVolume: number,
    cumulativeRealized: number,
    result: Record<string, unknown>,
  ): boolean {
    const operation = t.id
      ? this.db.getLatestUnresolvedExecutionForTrade(t.id, ['PARTIAL_CLOSE'])
      : null;
    if (!operation || !t.id) return false;

    const resolved = this.db.resolveReconciledPartialClose(
      t.id,
      String(operation.executionId),
      brokerVolume,
      cumulativeRealized,
      result,
      t.ticket,
    );
    if (!resolved) return false;

    this.logger.info(
      `[${operation.action}] atomically reconciled execution-ledger operation=${operation.operationKey}`,
    );
    return true;
  }

  private recordReconciledClose(
    t: Trade,
    exitPrice: number,
    exitReason: string,
    profit: number,
  ): void {
    this.tracker.recordClose(profit);
    const emoji = profit > 0 ? '💰' : '❌';
    const pnlStr = `${profit > 0 ? '+' : ''}${profit.toFixed(2)}`;
    this.telegram.sendMessage(
      `${emoji} <b>Trade Closed</b>: ${t.symbol} ${t.side}\n` +
      `P/L: <b>${pnlStr}</b> | Reason: ${exitReason}\n` +
      `Entry: ${t.entry.toFixed(5)} → Exit: ${exitPrice.toFixed(5)}`,
    ).catch(() => {});
    this.onClose({ ...t, status: 'closed', profit, exitPrice });
  }

  private resolveReconciledLedger(
    tradeId: number | undefined,
    actions: string[],
    result: Record<string, unknown>,
  ): void {
    if (!tradeId) return;
    const operation = this.db.getLatestUnresolvedExecutionForTrade(tradeId, actions);
    if (!operation) return;

    const resolved = this.db.resolveExecutionLedger(
      String(operation.executionId),
      result,
      result.ticket as string | number | undefined,
    );
    if (resolved) {
      this.logger.info(
        `[${operation.action}] reconciled execution-ledger operation=${operation.operationKey}`,
      );
    }
  }

  // ─── Binance ────────────────────────────────────────────────────────

  private getLatestBinanceOpenOperation(t: Trade): {
    executionId: string;
    operationKey: string;
  } | null {
    if (!t.id) return null;

    const row = this.db.getLatestExecutedOpenOperationForTrade(t.id);
    if (!row || row.conflict) {
      if (row?.conflict) {
        this.logger.error(
          `Conflicting executed OPEN identities for Binance Spot trade id=${t.id}`,
        );
      }
      return null;
    }

    return {
      executionId: String(row.executionId),
      operationKey: String(row.operationKey),
    };
  }

  private async verifyBinanceSpotProtection(t: Trade): Promise<void> {
    const openOperation = this.getLatestBinanceOpenOperation(t);
    if (!openOperation) {
      throw new Error(
        `No authoritative OPEN operation identity is available for Binance Spot trade id=${t.id}`,
      );
    }

    const list = await this.exec.recoverBinanceSpotOco(
      t.symbol,
      openOperation.operationKey,
    );
    if (!list) {
      throw new Error(
        `Binance Spot OCO protection could not be recovered for ${t.symbol}`,
      );
    }

    const listStatus = String(list.listStatusType).toUpperCase();
    const orderStatus = String(list.listOrderStatus).toUpperCase();
    if (
      !['EXEC_STARTED', 'EXECUTING'].includes(listStatus) &&
      !['EXECUTING'].includes(orderStatus)
    ) {
      throw new Error(
        `Binance Spot OCO protection is not active for ${t.symbol}: ${listStatus}/${orderStatus}`,
      );
    }

    const orders = Array.isArray(list.orders) ? list.orders : [];
    if (orders.length < 2) {
      throw new Error(
        `Binance Spot OCO protection has fewer than two legs for ${t.symbol}`,
      );
    }

    const openOrders = await this.exec.getBinanceOpenOrders(t.symbol);
    const byId = new Map(
      openOrders.map((order: any) => [Number(order.orderId), order]),
    );
    const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';

    const legOrders = orders
      .map((order: any) => byId.get(Number(order.orderId)))
      .filter(Boolean);

    if (legOrders.length !== 2) {
      throw new Error(
        `Binance Spot OCO legs are not both open for ${t.symbol}`,
      );
    }

    const tpTolerance = Math.max(1e-8, Math.abs(t.tp) * 1e-6);
    const slTolerance = Math.max(1e-8, Math.abs(t.sl) * 1e-6);
    const quantityTolerance = Math.max(
      1e-8,
      Math.abs(Number(t.volume)) * 0.0001,
    );
    const tpLeg = legOrders.find(
      (order: any) =>
        String(order.side).toUpperCase() === closeSide &&
        String(order.type).toUpperCase().includes('LIMIT') &&
        Math.abs(Number(order.origQty ?? order.quantity) - Number(t.volume)) <= quantityTolerance &&
        Math.abs(Number(order.price) - t.tp) <= tpTolerance &&
        String(order.status).toUpperCase() === 'NEW',
    );
    const slLeg = legOrders.find(
      (order: any) =>
        String(order.side).toUpperCase() === closeSide &&
        String(order.type).toUpperCase().includes('STOP') &&
        Math.abs(Number(order.origQty ?? order.quantity) - Number(t.volume)) <= quantityTolerance &&
        Math.abs(Number(order.stopPrice) - t.sl) <= slTolerance &&
        String(order.status).toUpperCase() === 'NEW',
    );

    if (!tpLeg || !slLeg) {
      throw new Error(
        `Binance Spot OCO protection prices/side do not match local trade id=${t.id}`,
      );
    }
  }

  private async reconcileBinance(t: Trade): Promise<void> {
    if (!t.ticket) return;

    const pos = await this.exec.getBinancePosition(t.symbol);
    const remaining = pos ? Math.abs(pos.positionAmt) : 0;
    const unresolvedClose = t.id
      ? this.db.getLatestUnresolvedExecutionForTrade(
          t.id,
          ['CLOSE', 'CLOSE_AT_MARKET'],
        )
      : null;
    const unresolvedPartial = t.id
      ? this.db.getLatestUnresolvedExecutionForTrade(
          t.id,
          ['PARTIAL_CLOSE'],
        )
      : null;
    const unresolvedModify = t.id
      ? this.db.getLatestUnresolvedExecutionForTrade(
          t.id,
          ['MOVE_SL_TP'],
        )
      : null;

    if (
      this.config.mode === 'binance' &&
      !this.config.binance.futures &&
      pos &&
      remaining > 0.0001
    ) {
      await this.verifyBinanceSpotProtection(t);
    }

    if (!pos || remaining < 0.0001) {
      if (
        unresolvedClose &&
        await this.reconcileBinanceFullClose(t, unresolvedClose)
      ) {
        return;
      }
      // Never infer a Binance close or PnL from the absence of a live position.
      // Older operations that predate durable clientOrderId support, or orders
      // without authoritative fill/PnL, remain unresolved and therefore blocked.
      throw new Error(
        `Binance position ${t.symbol} is absent but authoritative close execution/PnL recovery is unavailable`,
      );
    }

    if (unresolvedModify) {
      if (await this.reconcileBinanceModify(t, unresolvedModify)) {
        return;
      }
      throw new Error(
        `Binance protective-order state for unresolved MOVE_SL_TP is not provably safe for ${t.symbol}`,
      );
    }

    await this.verifyBinanceProtectionSafe(t);

    if (remaining < t.volume - 0.001) {
      if (
        unresolvedPartial &&
        await this.reconcileBinancePartialClose(t, unresolvedPartial, remaining)
      ) {
        return;
      }

      // External/manual partial reduction may still be reflected in local size,
      // but it does not resolve an UNKNOWN execution unless its exact broker
      // operation and authoritative fills are matched.
      this.logger.info(
        `[${t.symbol}] Binance partial: ${remaining} remaining`,
      );
      this.db.raw()
        .prepare('UPDATE trades SET volume=? WHERE id=? AND status=\\'open\\'')
        .run(remaining, t.id!);
    }
  }

  private async reconcileBinanceFullClose(
    t: Trade,
    operation: any,
  ): Promise<boolean> {
    if (!t.id) return false;
    const recovered = await this.exec.recoverBinanceExecution(
      t.symbol,
      String(operation.operationKey),
    );
    if (!recovered) return false;
    if (recovered.status !== 'FILLED') return false;

    const expectedVolume = Number(operation.volume ?? t.volume);
    if (
      !(recovered.executedQty > 0) ||
      Math.abs(recovered.executedQty - expectedVolume) >
        Math.max(1e-8, expectedVolume * 0.0001)
    ) {
      return false;
    }
    if (
      recovered.realizedProfit == null ||
      !Number.isFinite(recovered.realizedProfit)
    ) {
      return false;
    }

    const request = operation.requestJson
      ? (() => {
          try { return JSON.parse(operation.requestJson) as any; }
          catch { return null; }
        })()
      : null;
    const reason = String(request?.reason ?? 'MANUAL').toUpperCase();
    const exitPrice = Number(recovered.avgPrice);
    if (!(exitPrice > 0) || !Number.isFinite(exitPrice)) return false;

    const resolved = this.db.resolveReconciledFullClose(
      t.id,
      String(operation.executionId),
      recovered.realizedProfit,
      Date.now(),
      ['TP', 'SL', 'TIMEOUT', 'MANUAL'].includes(reason) ? reason : 'MANUAL',
      {
        broker: 'binance',
        ticket: t.ticket,
        brokerOrderId: recovered.orderId,
        executedQty: recovered.executedQty,
        realizedProfit: recovered.realizedProfit,
        avgPrice: exitPrice,
      },
      recovered.orderId,
    );
    if (!resolved) return false;

    this.recordReconciledClose(
      t,
      exitPrice,
      ['TP', 'SL', 'TIMEOUT', 'MANUAL'].includes(reason) ? reason : 'MANUAL',
      recovered.realizedProfit,
    );
    this.logger.info(
      `[${operation.action}] atomically recovered Binance close operation=${operation.operationKey}`,
    );
    return true;
  }

  private async verifyBinanceProtectionSafe(t: Trade): Promise<void> {
    const openOrders = await this.exec.getBinanceOpenOrders(t.symbol);
    const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';
    const matching = openOrders.filter(
      (order: any) => String(order.side).toUpperCase() === closeSide,
    );
    const tolerance = (target: number) =>
      Math.max(1e-8, Math.abs(target) * 1e-6);

    const slOrder = matching.find((order: any) => {
      const type = String(order.type ?? '').toUpperCase();
      const stop = Number(order.stopPrice);
      const closePosition = String(order.closePosition).toLowerCase() === 'true';
      return (
        type === 'STOP_MARKET' &&
        closePosition &&
        Number.isFinite(stop) &&
        Math.abs(stop - t.sl) <= tolerance(t.sl)
      );
    });

    const tpOrder = matching.find((order: any) => {
      const type = String(order.type ?? '').toUpperCase();
      const stop = Number(order.stopPrice);
      const closePosition = String(order.closePosition).toLowerCase() === 'true';
      return (
        type === 'TAKE_PROFIT_MARKET' &&
        closePosition &&
        Number.isFinite(stop) &&
        Math.abs(stop - t.tp) <= tolerance(t.tp)
      );
    });

    if (!slOrder || !tpOrder) {
      throw new Error(
        `Binance protective orders missing/mismatched for ${t.symbol}`,
      );
    }

    const positionEntry = await this.exec.getBinancePosition(t.symbol);
    if (!positionEntry || !(positionEntry.entryPrice > 0)) {
      throw new Error(
        `Binance protective-order verification lacks valid entry price for ${t.symbol}`,
      );
    }

    if (
      (t.side === 'BUY' && !(t.sl < positionEntry.entryPrice && t.tp > positionEntry.entryPrice)) ||
      (t.side === 'SELL' && !(t.sl > positionEntry.entryPrice && t.tp < positionEntry.entryPrice))
    ) {
      throw new Error(
        `Binance protective order direction invalid for ${t.symbol}`,
      );
    }
  }

  private async reconcileBinanceModify(
    t: Trade,
    operation: any,
  ): Promise<boolean> {
    if (!t.id) return false;

    let request: any;
    try {
      request = operation.requestJson
        ? JSON.parse(operation.requestJson)
        : null;
    } catch {
      return false;
    }

    const newSl = Number(request?.newSl);
    const newTp = Number(request?.newTp);
    if (
      !(newSl > 0) ||
      !(newTp > 0) ||
      !Number.isFinite(newSl) ||
      !Number.isFinite(newTp)
    ) {
      return false;
    }

    const recovered = await this.exec.recoverBinanceProtection(
      t.symbol,
      String(operation.operationKey),
    );
    const slOrder = recovered?.sl;
    const tpOrder = recovered?.tp;
    if (!slOrder || !tpOrder) return false;

    const slStatus = String(slOrder.status ?? '').toUpperCase();
    const tpStatus = String(tpOrder.status ?? '').toUpperCase();
    if (
      (slStatus && slStatus !== 'NEW') ||
      (tpStatus && tpStatus !== 'NEW')
    ) {
      return false;
    }

    const closeSide = t.side === 'BUY' ? 'SELL' : 'BUY';
    if (
      String(slOrder.side ?? '').toUpperCase() !== closeSide ||
      String(tpOrder.side ?? '').toUpperCase() !== closeSide
    ) {
      return false;
    }

    const priceTolerance = (target: number) =>
      Math.max(1e-8, Math.abs(target) * 1e-6);
    const slType = String(slOrder.type ?? '').toUpperCase();
    const tpType = String(tpOrder.type ?? '').toUpperCase();
    const slStop = Number(slOrder.stopPrice);
    const tpStop = Number(tpOrder.stopPrice);
    const tpPrice = Number(tpOrder.price);

    if (
      !/STOP_MARKET|STOP_LOSS/.test(slType) ||
      !Number.isFinite(slStop) ||
      Math.abs(slStop - newSl) > priceTolerance(newSl)
    ) {
      return false;
    }
    if (
      !/TAKE_PROFIT_MARKET|TAKE_PROFIT/.test(tpType) ||
      !(
        (Number.isFinite(tpStop) && Math.abs(tpStop - newTp) <= priceTolerance(newTp)) ||
        (Number.isFinite(tpPrice) && Math.abs(tpPrice - newTp) <= priceTolerance(newTp))
      )
    ) {
      return false;
    }

    const resolved = this.db.resolveReconciledSLTP(
      t.id,
      String(operation.executionId),
      newSl,
      newTp,
      {
        broker: 'binance',
        ticket: t.ticket,
        newSl,
        newTp,
        slOrderId: Number(slOrder.orderId),
        tpOrderId: Number(tpOrder.orderId),
        reconciliation: true,
      },
      Number(slOrder.orderId) > 0 ? Number(slOrder.orderId) : undefined,
    );
    if (!resolved) return false;

    this.logger.info(
      `[${operation.action}] reconciled Binance protective orders operation=${operation.operationKey}`,
    );
    return true;
  }

  private async reconcileBinancePartialClose(
    t: Trade,
    operation: any,
    remaining: number,
  ): Promise<boolean> {
    if (!t.id) return false;
    const recovered = await this.exec.recoverBinanceExecution(
      t.symbol,
      String(operation.operationKey),
    );
    if (!recovered) return false;
    if (recovered.status !== 'FILLED') return false;

    const requestedVolume = Number(operation.requestJson
      ? (() => {
          try { return JSON.parse(operation.requestJson)?.volume; }
          catch { return null; }
        })()
      : operation.volume);
    if (!(requestedVolume > 0)) return false;

    if (
      !(recovered.executedQty > 0) ||
      Math.abs(recovered.executedQty - requestedVolume) >
        Math.max(1e-8, requestedVolume * 0.0001)
    ) {
      return false;
    }
    if (
      recovered.realizedProfit == null ||
      !Number.isFinite(recovered.realizedProfit)
    ) {
      return false;
    }

    if (Math.abs(remaining - (t.volume - recovered.executedQty)) >
        Math.max(1e-8, t.volume * 0.0001)) {
      return false;
    }

    const cumulativeProfit =
      Number(t.realizedProfit ?? 0) + recovered.realizedProfit;
    if (!Number.isFinite(cumulativeProfit)) return false;

    const resolved = this.db.resolveReconciledPartialClose(
      t.id,
      String(operation.executionId),
      +remaining.toFixed(8),
      cumulativeProfit,
      {
        broker: 'binance',
        ticket: t.ticket,
        brokerOrderId: recovered.orderId,
        closedVolume: recovered.executedQty,
        remainingVolume: +remaining.toFixed(8),
        profit: recovered.realizedProfit,
        cumulativeRealizedProfit: cumulativeProfit,
      },
      recovered.orderId,
    );
    if (!resolved) return false;

    this.logger.info(
      `[${operation.action}] atomically recovered Binance partial operation=${operation.operationKey}`,
    );
    return true;
  }

  // ─── Common close + record ─────────────────────────────────────────

  private async closeAndRecord(
    t:          Trade,
    exitPrice:  number,
    exitReason: string,
    profit?:    number,
  ): Promise<void> {
    let rawProfit = profit;
    let persistedByExecutionGateway = false;

    if (rawProfit === undefined && this.config.mode === 'paper') {
      const settled = await this.exec.closeAtMarket(
        t,
        exitPrice,
        exitReason as 'TP' | 'SL' | 'TIMEOUT' | 'MANUAL',
      );
      if (!settled.ok || !Number.isFinite(Number(settled.profit))) {
        throw new Error(
          'Paper settlement could not produce authoritative PnL for ticket=' +
          t.ticket,
        );
      }
      rawProfit = Number(settled.profit);
      persistedByExecutionGateway = true;
    }

    // Never synthesize broker/account PnL from price differences. MT5/Binance
    // callers must provide authoritative realized PnL from broker history.
    if (rawProfit === undefined || !Number.isFinite(Number(rawProfit))) {
      throw new Error('Authoritative PnL unavailable for ticket=' + t.ticket);
    }

    const finalProfit = Number(rawProfit);

    if (!persistedByExecutionGateway) {
      const changed = this.db.updateTradeClose(t.id!, finalProfit, Date.now(), exitReason);
      if (!changed) {
        throw new Error('Could not persist closed trade id=' + t.id);
      }
    }
    this.tracker.recordClose(finalProfit);

    const emoji  = finalProfit > 0 ? '💰' : '❌';
    const pnlStr = `${finalProfit > 0 ? '+' : ''}$${finalProfit.toFixed(2)}`;

    await this.telegram.sendMessage(
      `${emoji} <b>Trade Closed</b>: ${t.symbol} ${t.side}\n` +
      `P/L: <b>${pnlStr}</b> | Reason: ${exitReason}\n` +
      `Entry: ${t.entry.toFixed(5)} → Exit: ${exitPrice.toFixed(5)}`,
    ).catch(() => {});

    this.logger.info(`Closed ${t.symbol} ${t.side} | ${pnlStr} | ${exitReason}`);
    this.onClose({ ...t, profit: finalProfit, exitPrice });
  }
}
