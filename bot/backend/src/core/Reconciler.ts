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
      } else {
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

          if (
            Number.isFinite(cumulativeRealized) &&
            Math.abs(cumulativeRealized - currentRealized) > 1e-8
          ) {
            this.logger.info(
              `[${t.symbol}] Reconciled cumulative realized PnL=${cumulativeRealized.toFixed(8)}`,
            );
          }

          if (Number.isFinite(cumulativeRealized)) {
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

  private async reconcileBinance(t: Trade): Promise<void> {
    if (!t.ticket) return;

    const pos = await this.exec.getBinancePosition(t.symbol);
    const liveVolume = pos && Number.isFinite(Number(pos.positionAmt))
      ? Math.abs(Number(pos.positionAmt))
      : 0;

    if (!pos || liveVolume < 1e-12) {
      const unresolved = t.id != null
        ? this.db.getUnresolvedExecutionsForTrade(
            t.id,
            ['CLOSE', 'CLOSE_AT_MARKET', 'PARTIAL_CLOSE'],
          )
        : [];

      const closes = unresolved.filter(row =>
        ['CLOSE', 'CLOSE_AT_MARKET'].includes(String(row.action)),
      );
      if (closes.length !== 1) {
        throw new Error(
          `Binance position ${t.symbol} is absent without exactly one attributable unresolved close; manual reconciliation is required`,
        );
      }

      const unresolvedClose = closes[0];
      const recovered = await this.exec.reconcileBinanceFullClose(
        String(unresolvedClose.operationKey),
        t.symbol,
        Number(unresolvedClose.createdAt),
      );

      const expectedQty = Math.abs(Number(t.volume));
      const qtyTolerance = Math.max(1e-12, expectedQty * 0.02);
      if (
        !Number.isFinite(recovered.executedQty) ||
        recovered.executedQty <= 0 ||
        !Number.isFinite(expectedQty) ||
        expectedQty <= 0 ||
        Math.abs(recovered.executedQty - expectedQty) > qtyTolerance
      ) {
        throw new Error(
          `Binance full-close recovery quantity mismatch for ${t.symbol}: recovered=${recovered.executedQty} expected=${expectedQty}`,
        );
      }

      const persisted = this.db.raw().prepare(
        'SELECT realizedProfit FROM trades WHERE id=? LIMIT 1',
      ).get(t.id!) as { realizedProfit?: number } | undefined;
      const priorRealized = Number(persisted?.realizedProfit ?? 0);
      if (!Number.isFinite(priorRealized) || !Number.isFinite(recovered.realizedProfit)) {
        throw new Error(`Binance full-close recovered PnL is invalid for ${t.symbol}`);
      }
      const cumulativeRealized = priorRealized + recovered.realizedProfit;
      if (!Number.isFinite(cumulativeRealized)) {
        throw new Error(`Binance cumulative realized PnL is invalid for ${t.symbol}`);
      }

      const resolved = this.db.resolveReconciledFullClose(
        t.id!,
        String(unresolvedClose.executionId),
        cumulativeRealized,
        Date.now(),
        'MANUAL',
        {
          broker: 'binance',
          symbol: t.symbol,
          orderId: recovered.orderId,
          executedQty: recovered.executedQty,
          realizedProfit: recovered.realizedProfit,
          cumulativeRealizedProfit: cumulativeRealized,
          runtimeReconciliation: true,
        },
        recovered.orderId,
      );
      if (!resolved) {
        throw new Error(
          `Could not atomically reconcile Binance full-close operation=${unresolvedClose.executionId}`,
        );
      }

      t.status = 'closed';
      t.profit = cumulativeRealized;
      t.realizedProfit = cumulativeRealized;
      this.tracker.recordClose(cumulativeRealized);
      this.onClose({ ...t, profit: cumulativeRealized });
      return;
    }

    const dbVolume = Math.abs(Number(t.volume));
    const volumeTolerance = Math.max(1e-12, dbVolume * 0.02);
    if (liveVolume < dbVolume - volumeTolerance) {
      const unresolvedPartials = t.id != null
        ? this.db.getUnresolvedExecutionsForTrade(t.id, ['PARTIAL_CLOSE'])
        : [];
      if (unresolvedPartials.length !== 1) {
        throw new Error(
          `Binance position size decreased for ${t.symbol} without exactly one attributable PARTIAL_CLOSE; manual reconciliation is required`,
        );
      }

      const unresolvedPartial = unresolvedPartials[0];
      const recovered = await this.exec.reconcileBinancePartialClose(
        String(unresolvedPartial.operationKey),
        t.symbol,
        Number(unresolvedPartial.createdAt),
      );

      const recoveredRemaining = Number(recovered.remainingVolume);
      const recoveredExecuted = Number(recovered.executedQty);
      const positionTolerance = Math.max(1e-12, dbVolume * 0.02);
      const expectedClosed = dbVolume - recoveredRemaining;
      if (
        !Number.isFinite(recoveredRemaining) ||
        recoveredRemaining <= 0 ||
        Math.abs(recoveredRemaining - liveVolume) > positionTolerance ||
        recoveredRemaining >= dbVolume ||
        !Number.isFinite(recoveredExecuted) ||
        recoveredExecuted <= 0 ||
        Math.abs(recoveredExecuted - expectedClosed) > positionTolerance
      ) {
        throw new Error(
          `Binance partial recovery quantity mismatch for ${t.symbol}: executed=${recoveredExecuted} expectedClosed=${expectedClosed} recoveredRemaining=${recoveredRemaining} live=${liveVolume} db=${dbVolume}`,
        );
      }

      const persisted = this.db.raw().prepare(
        'SELECT realizedProfit FROM trades WHERE id=? LIMIT 1',
      ).get(t.id!) as { realizedProfit?: number } | undefined;
      const priorRealized = Number(persisted?.realizedProfit ?? 0);
      if (!Number.isFinite(priorRealized) || !Number.isFinite(recovered.realizedProfit)) {
        throw new Error(`Binance partial recovered PnL is invalid for ${t.symbol}`);
      }
      const cumulativeRealized = priorRealized + recovered.realizedProfit;
      if (!Number.isFinite(cumulativeRealized)) {
        throw new Error(`Binance cumulative partial PnL is invalid for ${t.symbol}`);
      }

      const resolved = this.db.resolveReconciledPartialClose(
        t.id!,
        String(unresolvedPartial.executionId),
        recoveredRemaining,
        cumulativeRealized,
        {
          broker: 'binance',
          symbol: t.symbol,
          orderId: recovered.orderId,
          executedQty: recovered.executedQty,
          remainingVolume: recoveredRemaining,
          realizedProfit: recovered.realizedProfit,
          cumulativeRealizedProfit: cumulativeRealized,
          runtimeReconciliation: true,
        },
        recovered.orderId,
      );
      if (!resolved) {
        throw new Error(
          `Could not atomically reconcile Binance partial operation=${unresolvedPartial.executionId}`,
        );
      }

      t.volume = recoveredRemaining;
      t.realizedProfit = cumulativeRealized;
      this.logger.info(
        `[${t.symbol}] Binance partial recovered order=${recovered.orderId} remaining=${recoveredRemaining} cumulativePnL=${cumulativeRealized.toFixed(8)}`,
      );
    }
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
