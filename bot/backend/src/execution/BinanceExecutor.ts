Warning: truncated output (original token count: 17975)
Total output lines: 2210

/**
 * BINANCE EXECUTOR — v9.0 (COMPLETE FIX)
 * ═══════════════════════════════════════════════════════════════════════
 * [FIX-1] Real SL/TP Orders:
 *   يضع STOP_MARKET order للـ SL
 *   يضع TAKE_PROFIT_MARKET order للـ TP
 *   يتتبع orderId لكل SL/TP لإلغائها عند الإغلاق
 *
 * [FIX-2] Futures vs Spot:
 *   يستخدم fapi (Futures API) للـ SL/TP
 *   يدعم Spot و Futures في نفس الوقت
 *
 * [FIX-3] Position Management:
 *   يُتحقق من position side قبل الإغلاق
 *   يُلغي SL/TP orders عند الإغلاق اليدوي
 *
 * [FIX-4] Error Recovery:
 *   protective-order failure triggers emergency close; ambiguous live orders are reconciled by clientOrderId
 *   duplicate retries are prohibited
 * ═══════════════════════════════════════════════════════════════════════
 */
import axios, { AxiosInstance } from 'axios';
import * as crypto               from 'crypto';
import { Signal, SystemConfig, Trade } from '../types/trading.types';
import { getSymbolSpec }               from '../config/symbolConfig';
import { Logger }                      from '../utils/Logger';

interface OpenOrderIds {
  slOrderId?: number;
  tpOrderId?: number;
  orderListId?: number;
  closeSide?: 'BUY'|'SELL';
  quantity?: number;
}

export class BinanceExecutor {
  private logger = new Logger('BinanceExecutor');
  private http:  AxiosInstance;
  private isFutures: boolean;
  // Map ticket → {slOrderId, tpOrderId}
  private orderMap = new Map<number, OpenOrderIds>();

  constructor(private config: SystemConfig) {
    const isTestnet=config.binance.env==='testnet';
    this.isFutures=config.binance.futures;
    const baseURL=this.isFutures?(isTestnet?'https://testnet.binancefuture.com':'https://fapi.binance.com'):(isTestnet?'https://testnet.binance.vision':'https://api.binance.com');

    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'X-MBX-APIKEY': config.binance.apiKey },
    });
  }

  private async emergencyCloseAfterProtectionFailure(
    signal: Signal,
    quantity: number,
    operationKey?: string,
  ): Promise<void> {
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const spec = getSymbolSpec(signal.symbol);

    const before = await this.getPosition(signal.symbol);
    if (!before) {
      throw new Error(
        `Emergency close position state unavailable for ${signal.symbol}`,
      );
    }

    const beforeAmount = Math.abs(Number(before.positionAmt));
    const quantityTolerance = Math.max(
      spec.volumeStep,
      Math.abs(quantity) * 0.0001,
    );
    if (
      !Number.isFinite(beforeAmount) ||
      beforeAmount < quantity - quantityTolerance
    ) {
      throw new Error(
        `Emergency close quantity exceeds verified Binance inventory for ${signal.symbol}: requested=${quantity} available=${beforeAmount}`,
      );
    }

    const result = await this.signedPost(
      this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
      {
        symbol: signal.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: this.formatQty(quantity, spec.volumeStep),
        ...(this.isFutures ? { reduceOnly: 'true' } : {}),
        ...(operationKey
          ? { newClientOrderId: this.makeClientOrderId(`PROTECTION_FAIL:${operationKey}`) }
          : {}),
      },
    );

    const status = String(result?.status ?? '').toUpperCase();
    const executed = Number(result?.executedQty ?? result?.origQty ?? 0);
    if (status && status !== 'FILLED') {
      throw new Error(`Emergency close order not fully filled: status=${status}`);
    }
    if (!(executed > 0) || executed + Math.max(spec.volumeStep, 1e-12) < quantity) {
      throw new Error(
        `Emergency close executed insufficient quantity: requested=${quantity} executed=${executed}`,
      );
    }

    {
      const after = await this.getPosition(signal.symbol);
      if (!after) {
        throw new Error(
          `Emergency close executed but post-close position state is unavailable for ${signal.symbol}`,
        );
      }
      const remaining = Math.abs(Number(after.positionAmt));
      const expectedRemaining = beforeAmount - executed;
      if (
        !Number.isFinite(remaining) ||
        !Number.isFinite(expectedRemaining) ||
        expectedRemaining < -quantityTolerance ||
        Math.abs(remaining - Math.max(0, expectedRemaining)) > quantityTolerance
      ) {
        throw new Error(
          `Emergency close produced an unverified Binance inventory transition for ${signal.symbol}: before=${beforeAmount} executed=${executed} after=${remaining}`,
        );
      }
    }

    this.logger.error(
      `[Binance] Emergency close filled after protection failure: ${signal.symbol} qty=${executed}`,
    );
  }

  private async getSpotOrderFillSummary(
    symbol: string,
    orderId: number,
    expectedQty: number,
  ): Promise<{
    currency: string;
    avgPrice: number;
    feeQuote: number;
    totalQty: number;
    grossQuote: number;
  } | null> {
    if (
      this.isFutures ||
      !(orderId > 0) ||
      !Number.isFinite(orderId) ||
      !(expectedQty > 0) ||
      !Number.isFinite(expectedQty)
    ) {
      return null;
    }

    const quote = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
    if (!quote) return null;

    const trades = await this.signedGet('/api/v3/myTrades', {
      symbol,
      orderId,
      limit: 1000,
    });
    if (!Array.isArray(trades) || trades.length === 0) return null;

    const baseAsset = symbol.slice(0, -quote.length);
    let grossQuote = 0;
    let totalQty = 0;
    let feeQuote = 0;

    for (const fill of trades) {
      const price = Number(fill?.price);
      const qty = Number(fill?.qty);
      const commission = Number(fill?.commission ?? 0);
      const commissionAsset = String(fill?.commissionAsset ?? '').toUpperCase();
      if (
        !(price > 0) ||
        !Number.isFinite(price) ||
        !(qty > 0) ||
        !Number.isFinite(qty) ||
        !Number.isFinite(commission) ||
        commission < 0
      ) {
        return null;
      }
      if (!['USDT', 'USDC', 'BUSD', baseAsset].includes(commissionAsset)) {
        return null;
      }
      grossQuote += price * qty;
      totalQty += qty;
      if (commissionAsset === baseAsset) feeQuote += commission * price;
      else feeQuote += commission;
    }

    const tolerance = Math.max(
      getSymbolSpec(symbol).volumeStep,
      expectedQty * 0.0001,
    );
    if (
      !(totalQty > 0) ||
      !Number.isFinite(totalQty) ||
      Math.abs(totalQty - expectedQty) > tolerance ||
      !Number.isFinite(grossQuote) ||
      !Number.isFinite(feeQuote)
    ) {
      return null;
    }

    const avgPrice = grossQuote / totalQty;
    if (!(avgPrice > 0) || !Number.isFinite(avgPrice)) return null;

    return { currency: quote, avgPrice, feeQuote, totalQty, grossQuote };
  }

  private async getSpotOrderNetPnl(
    symbol: string,
    orderId: number,
    entryPrice: number,
    entrySide: 'BUY' | 'SELL',
    expectedExecutedQty: number,
  ): Promise<{ profit: number; currency: string; avgPrice: number | null } | null> {
    if (
      this.isFutures ||
      !(entryPrice > 0) ||
      !Number.isFinite(entryPrice)
    ) {
      return null;
    }

    const summary = await this.getSpotOrderFillSummary(
      symbol,
      orderId,
      expectedExecutedQty,
    );
    if (!summary) return null;

    const grossEntry = entryPrice * summary.totalQty;
    const exitNetQuote = summary.grossQuote - summary.feeQuote;
    const profit = entrySide === 'BUY'
      ? exitNetQuote - grossEntry
      : grossEntry - exitNetQuote;
    if (!Number.isFinite(profit)) return null;

    return {
      profit,
      currency: summary.currency,
      avgPrice: summary.avgPrice,
    };
  }

  private async getFuturesOrderFillSummary(
    symbol: string,
    orderId: number,
    expectedQty: number,
  ): Promise<{
    currency: string;
    avgPrice: number;
    commission: number;
    totalQty: number;
  } | null> {
    if (
      !this.isFutures ||
      !(orderId > 0) ||
      !Number.isFinite(orderId) ||
      !(expectedQty > 0) ||
      !Number.isFinite(expectedQty)
    ) {
      return null;
    }

    const fills = await this.signedGet('/fapi/v1/userTrades', {
      symbol,
      orderId,
    });
    if (!Array.isArray(fills) || fills.length === 0) return null;

    let currency = '';
    let weightedPrice = 0;
    let totalQty = 0;
    let commission = 0;

    for (const fill of fills) {
      const fillPrice = Number(fill?.price);
      const fillQty = Number(fill?.qty);
      const fee = Number(fill?.commission);
      const feeAsset = String(fill?.commissionAsset ?? '').toUpperCase();

      if (
        !(fillPrice > 0) ||
        !Number.isFinite(fillPrice) ||
        !(fillQty > 0) ||
        !Number.isFinite(fillQty) ||
        !Number.isFinite(fee) ||
        fee < 0 ||
        !['USDT', 'USDC', 'BUSD'].includes(feeAsset)
      ) {
        return null;
      }

      if (!currency) currency = feeAsset;
      else if (currency !== feeAsset) return null;

      weightedPrice += fillPrice * fillQty;
      totalQty += fillQty;
      commission += fee;
    }

    const tolerance = Math.max(
      getSymbolSpec(symbol).volumeStep,
      expectedQty * 0.0001,
    );
    if (
      !currency ||
      !(totalQty > 0) ||
      !Number.isFinite(totalQty) ||
      Math.abs(totalQty - expectedQty) > tolerance ||
      !(commission >= 0) ||
      !Number.isFinite(commission)
    ) {
      return null;
    }

    const avgPrice = weightedPrice / totalQty;
    if (!(avgPrice > 0) || !Number.isFinite(avgPrice)) return null;

    return {
      currency,
      avgPrice,
      commission,
      totalQty,
    };
  }

  private async getFuturesOrderNetPnl(
    symbol: string,
    orderId: number,
  ): Promise<{ profit: number; currency: string; avgPrice: number | null } | null> {
    if (!this.isFutures || !(orderId > 0)) return null;

    const fills = await this.signedGet('/fapi/v1/userTrades', {
      symbol,
      orderId,
    });

    if (!Array.isArray(fills) || fills.length === 0) return null;

    let net = 0;
    let currency = '';
    let weightedPrice = 0;
    let totalQty = 0;

    for (const fill of fills) {
      const realizedPnl = Number(fill?.realizedPnl);
      const commission = Number(fill?.commission);
      const fillPrice = Number(fill?.price);
      const fillQty = Number(fill?.qty);
      const commissionAsset = String(
        fill?.commissionAsset ?? '',
      ).toUpperCase();

      if (
        !Number.isFinite(realizedPnl) ||
        !Number.isFinite(commission) ||
        commission < 0
      ) {
        return null;
      }

      if (!['USDT', 'USDC', 'BUSD'].includes(commissionAsset)) {
        return null;
      }

      if (!currency) currency = commissionAsset;
      else if (currency !== commissionAsset) return null;

      net += realizedPnl - commission;
      if (
        Number.isFinite(fillPrice) &&
        Number.isFinite(fillQty) &&
        fillPrice > 0 &&
        fillQty > 0
      ) {
        weightedPrice += fillPrice * fillQty;
        totalQty += fillQty;
      }
    }

    if (!currency || !Number.isFinite(net)) return null;
    const avgPrice = totalQty > 0 ? weightedPrice / totalQty : null;
    return {
      profit: net,
      currency,
      avgPrice: Number.isFinite(avgPrice ?? NaN) ? avgPrice : null,
    };
  }


  async recoverSpotOcoByOperation(
    symbol: string,
    operationKey: string,
  ): Promise<{
    orderListId: number;
    listStatusType: string;
    listOrderStatus: string;
    orders: any[];
  } | null> {
    if (this.isFutures) return null;
    try {
      const listClientOrderId = this.makeOcoClientOrderId(
        operationKey,
        'LIST',
      );
      const list = await this.getSpotOcoByClientId(
        symbol,
        listClientOrderId,
      );
      if (!list) return null;

      const listStatusType = String(list.listStatusType ?? '').toUpperCase();
      const listOrderStatus = String(list.listOrderStatus ?? '').toUpperCase();
      if (
        !['EXEC_STARTED', 'EXECUTING', 'ALL_DONE'].includes(listStatusType) &&
        !['EXECUTING', 'ALL_DONE'].includes(listOrderStatus)
      ) {
        return null;
      }

      if (
        String(list.symbol ?? '').toUpperCase() !== String(symbol).toUpperCase() ||
        String(list.listClientOrderId ?? '') !== listClientOrderId
      ) {
        return null;
      }

      const orders = Array.isArray(list.orders) ? list.orders : [];
      if (orders.length < 2) return null;

      const orderIds = orders
        .map((order: any) => Number(order.orderId))
        .filter((id: number) => Number.isFinite(id) && id > 0);
      if (orderIds.length !== 2 || new Set(orderIds).size !== 2) return null;

      return {
        orderListId: Number(list.orderListId),
        listStatusType,
        listOrderStatus,
        orders,
      };
    } catch (e: any) {
      this.logger.warn(
        `[Binance Spot] recoverSpotOcoByOperation failed: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  async recoverProtectionByOperation(
    symbol: string,
    operationKey: string,
  ): Promise<{
    sl: any | null;
    tp: any | null;
  }> {
    try {
      const sl = await this.findOrderByClientId(
        symbol,
        this.makeProtectionClientOrderId(operationKey, 'SL'),
      );
      const tp = await this.findOrderByClientId(
        symbol,
        this.makeProtectionClientOrderId(operationKey, 'TP'),
      );
      return { sl: sl ?? null, tp: tp ?? null };
    } catch (e: any) {
      this.logger.warn(
        `[Binance] recoverProtectionByOperation failed: ${e?.message ?? e}`,
      );
      return { sl: null, tp: null };
    }
  }

  async recoverOperation(
    symbol: string,
    operationKey: string,
    entryPrice?: number,
    entrySide?: 'BUY' | 'SELL',
  ): Promise<{
    orderId: number;
    status: string;
    executedQty: number;
    avgPrice: number;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  } | null> {
    return this.recoverOrderByClientId(
      symbol,
      this.makeClientOrderId(operationKey),
      entryPrice,
      entrySide,
    );
  }

  async recoverOrderByClientId(
    symbol: string,
    clientOrderId: string,
    entryPrice?: number,
    entrySide?: 'BUY' | 'SELL',
  ): Promise<{
    orderId: number;
    status: string;
    executedQty: number;
    avgPrice: number;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  } | null> {
    try {
      const order = await this.findOrderByClientId(symbol, clientOrderId);
      if (!order) return null;
      const orderId = Number(order.orderId);
      const executedQty = Number(order.executedQty ?? order.cumQty ?? 0);
      const avgPrice = Number(order.avgPrice ?? 0);
      if (!(orderId > 0) || !Number.isFinite(orderId)) return null;
      if (!(executedQty >= 0) || !Number.isFinite(executedQty)) return null;

      if (!this.isFutures) {
        const status = String(order.status ?? '').toUpperCase();
        if (status !== 'FILLED' || !(executedQty > 0)) {
          return {
            orderId,
            status,
            executedQty,
            avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
            realizedProfit: null,
            realizedProfitCurrency: null,
          };
        }

        if (
          !Number.isFinite(Number(entryPrice)) ||
          !(Number(entryPrice) > 0) ||
          !entrySide
        ) {
          return null;
        }

        const realized = await this.getSpotOrderNetPnl(
          symbol,
          orderId,
          Number(entryPrice),
          entrySide,
          executedQty,
        );

        return {
          orderId,
          status,
          executedQty,
          avgPrice: Number.isFinite(avgPrice)
            ? avgPrice
            : (realized?.avgPrice ?? 0),
          realizedProfit: realized?.profit ?? null,
          realizedProfitCurrency: realized?.currency ?? null,
        };
      }

      const realized = await this.getFuturesOrderNetPnl(symbol, orderId);
      const recoveredAvgPrice =
        Number.isFinite(avgPrice) && avgPrice > 0
          ? avgPrice
          : realized?.avgPrice ?? null;
      return {
        orderId,
        status: String(order.status ?? '').toUpperCase(),
        executedQty,
        avgPrice: recoveredAvgPrice ?? 0,
        realizedProfit: realized?.profit ?? null,
        realizedProfitCurrency: realized?.currency ?? null,
      };
    } catch (e: any) {
      this.logger.warn(
        `[Binance] recoverOrderByClientId failed: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  private makeClientOrderId(operationKey: string): string {
    const digest = crypto
      .createHash('sha256')
      .update(operationKey)
      .digest('hex')
      .slice(0, 27);
    return `ta_${digest}`;
  }

  private makeProtectionClientOrderId(
    operationKey: string,
    kind: 'SL' | 'TP',
  ): string {
    const digest = crypto
      .createHash('sha256')
      .update(`PROTECTION:${kind}:${operationKey}`)
      .digest('hex')
      .slice(0, 27);
    const id = `ta${kind.toLowerCase()}_${digest}`;
    if (id.length > 32) {
      throw new Error(`Generated Binance protection clientOrderId exceeds 32 chars: ${id.length}`);
    }
    return id;
  }

  private makeOcoClientOrderId(
    operationKey: string,
    kind: 'LIST' | 'ABOVE' | 'BELOW',
  ): string {
    const digest = crypto
      .createHash('sha256')
      .update(`SPOT_OCO:${kind}:${operationKey}`)
      .digest('hex')
      .slice(0, 27);
    const id = `tao${kind === 'LIST' ? 'l' : kind === 'ABOVE' ? 'a' : 'b'}_${digest}`;
    if (id.length > 32) {
      throw new Error(`Generated Binance Spot OCO clientOrderId exceeds 32 chars: ${id.length}`);
    }
    return id;
  }

  private async getSpotOcoByClientId(
    symbol: string,
    listClientOrderId: string,
  ): Promise<any | null> {
    return this.signedGet('/api/v3/orderList', {
      symbol,
      origClientOrderId: listClientOrderId,
    });
  }

  private async findOrderByClientId(symbol: string, clientOrderId: string): Promise<any | null> {
    try {
      return await this.signedGet(
        this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
        this.isFutures
          ? { symbol, origClientOrderId: clientOrderId }
          : { symbol, origClientOrderId: clientOrderId },
      );
    } catch {
      return null;
    }
  }

  // ─── Ping ──────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.http.get(this.isFutures ? '/fapi/v1/ping' : '/api/v3/ping');
      if (this.isFutures) {
        const mode = await this.signedGet('/fapi/v1/positionSide/dual', {});
        if (mode?.dualSidePosition === true) {
          throw new Error('Binance hedge/dual-side position mode is not supported; configure one-way mode');
        }
      }
      return true;
    } catch { return false; }
  }

  // ─── Place Order with SL/TP ────────────────────────────────────────────

  async placeMarketOrder(signal: Signal, quantity: number, clientOrderId?: string): Promise<Trade | null> {
    const spec = getSymbolSpec(signal.symbol);
    if (!this.isFutures && signal.side === 'SELL') {
      this.logger.error(`[Binance Spot] SELL/short semantics are unsupported by this executor; trade blocked`);
      return null;
    }
    try {
      // 1. Market entry order
      const entry = await this.signedPost(
        this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
        {
          symbol:   signal.symbol,
          side:     signal.side,
          type:     'MARKET',
          quantity: this.formatQty(quantity, spec.volumeStep),
          ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
        }
      );

      let fillPrice = Number(entry.avgPrice ?? entry.fills?.[0]?.price ?? 0);
      const executedQty = Number(entry.executedQty ?? entry.origQty ?? quantity);
      const ticket = Number(entry.orderId);
      let entryCommission = 0;
      let entryCommissionCurrency: string | undefined;
      if (!this.isFutures) {
        const summary = await this.getSpotOrderFillSummary(
          signal.symbol,
          ticket,
          executedQty,
        );
        if (!summary) {
          throw new Error(
            `Binance Spot entry fills/commission could not be verified for ${signal.symbol}`
          );
        }
        fillPrice = summary.avgPrice;
        entryCommission = summary.feeQuote;
        entryCommissionCurrency = summary.currency;
      } else {
        const summary = await this.getFuturesOrderFillSummary(
          signal.symbol,
          ticket,
          executedQty,
        );
        if (!summary) {
          throw new Error(
            `Binance Futures entry fills/commission could not be verified for ${signal.symbol}`
          );
        }
        fillPrice = summary.avgPrice;
        entryCommission = summary.commission;
        entryCommissionCurrency = summary.currency;
      }
      if (!(fillPrice > 0) || !Number.isFinite(fillPrice)) {
        throw new Error('Binance order returned invalid fill price');
      }
      if (!(executedQty > 0) || !Number.isFinite(executedQty)) {
        throw new Error('Binance order returned invalid executed quantity');
      }

      this.logger.info(
        `[Binance] Entry: ${signal.side} ${quantity} ${signal.symbol} ` +
        `@ ${fillPrice} ticket=${ticket}`
      );

      // 2. Protective orders are fail-safe: the trade is NOT accepted unless
      //    SL+TP (or Spot OCO) are confirmed. If protection fails, attempt an
      //    immediate market close so we never knowingly continue unprotected.
      try {
        if (this.isFutures) {
          await this.placeSLTP(signal, executedQty, ticket, spec, clientOrderId);
        } else {
          await this.placeOCO(
            signal,
            executedQty,
            ticket,
            spec,
            clientOrderId,
          );
        }
      } catch (protectionError: any) {
        this.logger.error(`CRITICAL: protective orders failed for ${signal.symbol}: ${protectionError?.message ?? protectionError}`);
        const emergencyError = await this.emergencyCloseAfterProtectionFailure(
          signal,
          executedQty,
          clientOrderId,
        ).catch(e => e);
        if (emergencyError) throw new Error(`Protection failed and emergency close failed for ${signal.symbol}`);
        if (this.isFutures) {
          const remaining = await this.getPosition(signal.symbol);
          if (remaining && Math.abs(remaining.positionAmt) > 0)
            throw new Error(`Protection failed and position remains open for ${signal.symbol}`);
        }
        return null;
      }

      return {
        ticket,
        symbol: signal.symbol,
        side: signal.side,
        volume: executedQty,
        entry: fillPrice,
        sl: signal.sl,
        tp: signal.tp,
        status: 'open',
        openedAt: Date.now(),
        source: signal.source,
        ...(entryCommission > 0
          ? {
              commission: entryCommission,
              commissionCurrency: entryCommissionCurrency,
            }
          : {}),
      };

    } catch (e: any) {
      if (clientOrderId) {
        const recovered = await this.findOrderByClientId(signal.symbol,…5975 tokens truncated…n could not be verified for ${symbol}`,
        );
      }
      return;
    }

    const finalStatus = String(after.listStatusType ?? '').toUpperCase();
    const finalOrderStatus = String(after.listOrderStatus ?? '').toUpperCase();
    if (
      finalStatus !== 'ALL_DONE' &&
      finalOrderStatus !== 'ALL_DONE'
    ) {
      throw new Error(
        `Binance Spot OCO cancellation not complete for ${symbol}: ${finalStatus}/${finalOrderStatus}`,
      );
    }

    const orderIds = (Array.isArray(list.orders) ? list.orders : [])
      .map((order: any) => Number(order.orderId))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    if (!orderIds.length) {
      throw new Error(
        `Binance Spot OCO had no verifiable leg identities during cancellation for ${symbol}`,
      );
    }

    const openOrders = await this.getOpenOrders(symbol);
    const survivors = openOrders.filter((order: any) =>
      orderIds.includes(Number(order.orderId)),
    );
    if (survivors.length > 0) {
      throw new Error(
        `Binance Spot OCO legs are still open after cancellation for ${symbol}`,
      );
    }
  }


  private async getProtectiveOrderIds(
    symbol: string,
    side: 'BUY' | 'SELL',
  ): Promise<number[]> {
    const openOrders = await this.getOpenOrders(symbol);
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    return openOrders
      .filter((order: any) => {
        const type = String(order.type ?? '').toUpperCase();
        const orderSide = String(order.side ?? '').toUpperCase();
        const closePosition = String(order.closePosition).toLowerCase() === 'true';
        return (
          orderSide === closeSide &&
          closePosition &&
          (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET')
        );
      })
      .map((order: any) => Number(order.orderId))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  }

  async modifyPosition(
    ticket:number,
    symbol:string,
    side:'BUY'|'SELL',
    newSl:number,
    newTp:number,
    protectionKey?: string,
  ):Promise<boolean>{
    if(!this.isFutures)return false;
    try{
      const ids=this.orderMap.get(ticket);
      const trackedIds=[ids?.slOrderId,ids?.tpOrderId].filter(
        (id): id is number => Number.isFinite(id),
      );
      const brokerIds = await this.getProtectiveOrderIds(symbol, side);
      const oldIds = [...new Set([...trackedIds, ...brokerIds])];

      for(const orderId of oldIds) {
        await this.signedDelete('/fapi/v1/order',{symbol,orderId});
      }

      if (oldIds.length) {
        const remaining = await this.getOpenOrders(symbol);
        const stillOpen = remaining.some((order: any) =>
          oldIds.includes(Number(order.orderId)),
        );
        if (stillOpen) {
          throw new Error(
            `protective order cancellation not verified for ${symbol}`,
          );
        }
      }

      const position = await this.getPosition(symbol);
      if (!position) {
        throw new Error(
          `Binance position state unavailable while modifying ${symbol}`,
        );
      }
      const quantity=ids?.quantity ?? Math.abs(position.positionAmt ?? 0);
      if(!(quantity>0)) return false;

      const sig={
        symbol,
        side,
        price:0,
        confidence:1,
        sl:newSl,
        tp:newTp,
        source:'modify',
        reason:'modify',
        timestamp:Date.now(),
      } as Signal;

      await this.placeSLTP(
        sig,
        quantity,
        ticket,
        getSymbolSpec(symbol),
        protectionKey,
      );
      return true;
    }catch(e:any){
      this.logger.warn(`modifyPosition failed: ${e?.message??e}`);
      return false;
    }
  }

  async closePartialPosition(
    ticket:number,
    symbol:string,
    volume:number,
    clientOrderId?: string,
  ):Promise<{
    ok:boolean;
    remainingVolume:number;
    realizedProfit:number;
    realizedProfitCurrency:string|null;
  }>{
    if(!this.isFutures || !(volume>0)) {
      return {
        ok:false,
        remainingVolume:0,
        realizedProfit:0,
        realizedProfitCurrency:null,
      };
    }
    try {
      const pos=await this.getPosition(symbol);
      if(!pos || pos.positionAmt===0) {
        return {
          ok:false,
          remainingVolume:0,
          realizedProfit:0,
          realizedProfitCurrency:null,
        };
      }

      const available=Math.abs(pos.positionAmt);
      const qty=Math.min(volume,available);
      if(!(qty>0)) {
        return {
          ok:false,
          remainingVolume:available,
          realizedProfit:0,
          realizedProfitCurrency:null,
        };
      }

      const closeSide=pos.positionAmt>0?'SELL':'BUY';
      const order=await this.signedPost('/fapi/v1/order',{
        symbol,
        side:closeSide,
        type:'MARKET',
        quantity:this.formatQty(qty,getSymbolSpec(symbol).volumeStep),
        reduceOnly:'true',
        ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
      });

      const orderId=Number(order?.orderId);
      if(!(orderId>0) || !Number.isFinite(orderId)) {
        throw new Error('Binance partial close returned invalid orderId');
      }

      const executedQty = Number(order?.executedQty ?? order?.origQty ?? 0);
      const status = String(order?.status ?? '').toUpperCase();
      if (status && status !== 'FILLED') {
        throw new Error(`Binance partial close was not fully filled: status=${status}`);
      }
      if (
        !(executedQty > 0) ||
        Math.abs(executedQty - qty) >
          Math.max(getSymbolSpec(symbol).volumeStep, qty * 0.0001)
      ) {
        throw new Error(
          `Binance partial close executed unexpected quantity: requested=${qty} executed=${executedQty}`,
        );
      }

      const after=await this.getPosition(symbol);
      if (!after) {
        throw new Error(
          `Binance partial close ${symbol} executed but remaining position could not be verified`,
        );
      }
      const remainingVolume=Math.max(0,Math.abs(after.positionAmt));

      const realized=await this.getFuturesOrderNetPnl(symbol,orderId);
      if(realized==null) {
        throw new Error(
          `Binance partial close ${symbol} executed but authoritative fills/PnL are unavailable`,
        );
      }

      const ids=this.orderMap.get(ticket);
      if(ids) ids.quantity=remainingVolume;

      return {
        ok:true,
        remainingVolume,
        realizedProfit:realized.profit,
        realizedProfitCurrency:realized.currency,
      };
    }catch(e:any){
      this.logger.error(`closePartialPosition failed: ${e?.message??e}`);
      return {
        ok:false,
        remainingVolume:0,
        realizedProfit:0,
        realizedProfitCurrency:null,
      };
    }
  }


  // ─── Close position ───────────────────────────────────────────────────

  async closePosition(
    ticket: number,
    symbol: string,
    volume?: number,
    side?: 'BUY' | 'SELL',
    clientOrderId?: string,
    protectionOperationKey?: string,
    entryPrice?: number,
  ): Promise<{
    ok: boolean;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  }> {
    let realizedProfit: number | null = null;
    let realizedProfitCurrency: string | null = null;

    try {
      const ids = this.orderMap.get(ticket);
      const trackedIds = [
        ids?.slOrderId,
        ids?.tpOrderId,
      ].filter((id): id is number => Number.isFinite(id));

      if (
        !this.isFutures &&
        protectionOperationKey
      ) {
        await this.cancelSpotProtectionByOperation(
          symbol,
          protectionOperationKey,
        );
      } else if (
        !this.isFutures &&
        trackedIds.length === 0
      ) {
        throw new Error(
          `Binance Spot close lacks an authoritative OCO identity after restart for ${symbol}`,
        );
      }
      let protectionSide: 'BUY' | 'SELL' | undefined = side;
      if (!protectionSide && ids?.closeSide) {
        protectionSide = ids.closeSide === 'SELL' ? 'BUY' : 'SELL';
      }

      const brokerProtectionIds =
        this.isFutures && protectionSide
          ? await this.getProtectiveOrderIds(symbol, protectionSide)
          : [];
      const oldOrderIds = this.isFutures
        ? [...new Set([...trackedIds, ...brokerProtectionIds])]
        : protectionOperationKey
          ? []
          : [...new Set(trackedIds)];

      for (const orderId of oldOrderIds) {
        await this.signedDelete(
          this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
          { symbol, orderId },
        );
      }

      if (oldOrderIds.length) {
        const openOrders = await this.getOpenOrders(symbol);
        const staleProtectiveOrders = openOrders.filter((order: any) =>
          oldOrderIds.includes(Number(order.orderId)),
        );
        if (staleProtectiveOrders.length > 0) {
          throw new Error(
            `Binance protective order cancellation could not be verified for ${symbol}`,
          );
        }
      }

      this.orderMap.delete(ticket);

      if (this.isFutures) {
        const pos = await this.getPosition(symbol);
        if (!pos) {
          throw new Error(
            `Binance position state unavailable while closing ${symbol}`,
          );
        }
        if (pos.positionAmt === 0) {
          throw new Error(
            `Binance position ${symbol} is already flat; ownership of a prior close cannot be inferred safely`,
          );
        }

        const closeQty = volume ?? Math.abs(pos.positionAmt);
        const closeSide = pos.positionAmt > 0 ? 'SELL' : 'BUY';

        const closeOrder = await this.signedPost('/fapi/v1/order', {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: this.formatQty(
            Math.abs(closeQty),
            getSymbolSpec(symbol).volumeStep,
          ),
          reduceOnly: 'true',
          ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
        });

        const closeOrderId = Number(closeOrder?.orderId);
        if (!(closeOrderId > 0) || !Number.isFinite(closeOrderId)) {
          throw new Error('Binance full close returned invalid orderId');
        }

        const executedQty = Number(
          closeOrder?.executedQty ?? closeOrder?.origQty ?? 0,
        );
        const closeStatus = String(closeOrder?.status ?? '').toUpperCase();
        const quantityTolerance = Math.max(
          getSymbolSpec(symbol).volumeStep,
          Math.abs(closeQty) * 0.0001,
        );
        if (closeStatus && closeStatus !== 'FILLED') {
          throw new Error(
            `Binance full close was not fully filled: status=${closeStatus}`,
          );
        }
        if (
          !(executedQty > 0) ||
          Math.abs(executedQty - Math.abs(closeQty)) > quantityTolerance
        ) {
          throw new Error(
            `Binance full close executed unexpected quantity: requested=${Math.abs(closeQty)} executed=${executedQty}`,
          );
        }

        const after = await this.getPosition(symbol);
        if (!after) {
          throw new Error(
            `Binance full close ${symbol} executed but zero position could not be verified`,
          );
        }
        const remaining = Math.abs(after.positionAmt);
        if (remaining > quantityTolerance) {
          throw new Error(
            `Binance full close left position open: ${symbol} remaining=${remaining}`,
          );
        }

        const realized = await this.getFuturesOrderNetPnl(
          symbol,
          closeOrderId,
        );
        if (realized == null) {
          throw new Error(
            `Binance full close ${symbol} executed but authoritative fills/PnL are unavailable`,
          );
        }

        realizedProfit = realized.profit;
        realizedProfitCurrency = realized.currency;
      } else {
        const closeSide = ids?.closeSide ?? (
          side === 'BUY'
            ? 'SELL'
            : side === 'SELL'
              ? 'BUY'
              : undefined
        );
        const closeQty = volume ?? ids?.quantity;

        if (!closeSide || !(closeQty > 0)) {
          return {
            ok:false,
            realizedProfit:null,
            realizedProfitCurrency:null,
          };
        }

        const spec = getSymbolSpec(symbol);
        const before = await this.getPosition(symbol);
        if (!before) {
          throw new Error(
            `Binance Spot position state unavailable before closing ${symbol}`,
          );
        }
        const available = Number(before.positionAmt);
        const quantityTolerance = Math.max(
          spec.volumeStep,
          Math.abs(closeQty) * 0.0001,
        );
        if (
          !(available > 0) ||
          !Number.isFinite(available) ||
          closeQty > available + quantityTolerance
        ) {
          throw new Error(
            `Binance Spot close quantity exceeds verified inventory for ${symbol}: requested=${closeQty} available=${available}`,
          );
        }

        const closeOrder = await this.signedPost('/api/v3/order', {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: this.formatQty(
            closeQty,
            spec.volumeStep,
          ),
          newOrderRespType: 'FULL',
        });

        const status = String(closeOrder?.status ?? '').toUpperCase();
        const executedQty = Number(
          closeOrder?.executedQty ??
          closeOrder?.origQty ??
          0,
        );
        if (status && status !== 'FILLED') {
          throw new Error(
            `Binance Spot market close was not fully filled: status=${status}`,
          );
        }
        if (
          !(executedQty > 0) ||
          Math.abs(executedQty - closeQty) > quantityTolerance
        ) {
          throw new Error(
            `Binance Spot market close executed unexpected quantity: requested=${closeQty} executed=${executedQty}`,
          );
        }

        const orderId = Number(closeOrder?.orderId);
        if (!(orderId > 0) || !Number.isFinite(orderId)) {
          throw new Error(
            `Binance Spot market close returned invalid orderId for ${symbol}`,
          );
        }

        if (
          !Number.isFinite(Number(entryPrice)) ||
          !(Number(entryPrice) > 0) ||
          !side
        ) {
          throw new Error(
            `Binance Spot close lacks the local entry price/side required for authoritative PnL for ${symbol}`,
          );
        }

        const realized = await this.getSpotOrderNetPnl(
          symbol,
          orderId,
          Number(entryPrice),
          side,
          executedQty,
        );
        if (!realized) {
          throw new Error(
            `Binance Spot close fills/PnL could not be verified for ${symbol}`,
          );
        }
        realizedProfit = realized.profit;
        realizedProfitCurrency = realized.currency;

        const after = await this.getPosition(symbol);
        if (!after) {
          throw new Error(
            `Binance Spot post-close position state unavailable for ${symbol}`,
          );
        }
        const remaining = Number(after.positionAmt);
        const expectedRemaining = available - executedQty;
        if (
          !Number.isFinite(remaining) ||
          !Number.isFinite(expectedRemaining) ||
          expectedRemaining < -quantityTolerance ||
          Math.abs(remaining - expectedRemaining) > quantityTolerance
        ) {
          throw new Error(
            `Binance Spot market close produced an unexpected inventory transition for ${symbol}: before=${available} executed=${executedQty} after=${remaining}`,
          );
        }
      }

      return {
        ok: true,
        realizedProfit,
        realizedProfitCurrency,
      };
    } catch(e:any) {
      this.logger.error(`closePosition failed: ${e?.message??e}`);
      return {
        ok:false,
        realizedProfit:null,
        realizedProfitCurrency:null,
      };
    }
  }


  // ─── Get position ────────────────────────────────────────────────────

  async getPosition(symbol: string): Promise<{ positionAmt: number; entryPrice: number; unrealizedProfit: number } | null> {
    if (this.isFutures) {
      const res = await this.signedGet('/fapi/v2/positionRisk', { symbol });
      const pos = Array.isArray(res) ? res.find((p: any) => p.symbol === symbol) : res;
      if (!pos) return null;
      const positionAmt = Number(pos.positionAmt);
      const entryPrice = Number(pos.entryPrice);
      const unrealizedProfit = Number(pos.unRealizedProfit);
      if (![positionAmt, entryPrice, unrealizedProfit].every(Number.isFinite)) {
        throw new Error(`Binance returned invalid futures position metadata for ${symbol}`);
      }
      return { positionAmt, entryPrice, unrealizedProfit };
    }

    // Spot has no positionRisk endpoint. Reconciliation treats the base-asset
    // free+locked balance as the authoritative open position amount.
    const quote = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
    if (!quote) throw new Error(`Unsupported Binance Spot quote asset for ${symbol}`);
    const baseAsset = symbol.slice(0, -quote.length);
    const account = await this.signedGet('/api/v3/account', {});
    const balance = (account.balances as any[])?.find(
      (b: any) => String(b.asset).toUpperCase() === baseAsset,
    );
    if (!balance) return { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0 };

    const free = Number(balance.free ?? 0);
    const locked = Number(balance.locked ?? 0);
    if (![free, locked].every(Number.isFinite) || free < 0 || locked < 0) {
      throw new Error(`Binance returned invalid spot balance for ${baseAsset}`);
    }
    return {
      positionAmt: free + locked,
      entryPrice: 0,
      unrealizedProfit: 0,
    };
  }


  // ─── Account equity ──────────────────────────────────────────────────

  async accountEquity(): Promise<number> {
    if (this.isFutures) {
      const r = await this.signedGet('/fapi/v2/account', {});
      // totalMarginBalance includes current unrealized PnL and is the proper
      // current-equity basis for drawdown and exposure controls.
      const equity = Number(r.totalMarginBalance);
      if (!(equity > 0) || !Number.isFinite(equity)) {
        throw new Error('Binance futures margin equity unavailable or invalid');
      }
      return equity;
    }

    const r = await this.signedGet('/api/v3/account', {});
    if (!Array.isArray(r?.balances)) {
      throw new Error('Binance spot account balances unavailable or invalid');
    }

    const stable = new Set(['USDT', 'USDC', 'BUSD']);
    const balances = r.balances
      .map((b: any) => ({
        asset: String(b.asset ?? '').toUpperCase(),
        quantity: Number(b.free ?? 0) + Number(b.locked ?? 0),
      }))
      .filter((b: any) =>
        b.asset &&
        Number.isFinite(b.quantity) &&
        b.quantity > 0,
      );

    let equity = 0;
    const nonStable = balances.filter((b: any) => !stable.has(b.asset));

    for (const balance of balances) {
      if (stable.has(balance.asset)) {
        // USDT/USDC/BUSD are treated as USD-equivalent settlement assets in
        // this executor, consistent with the rest of the spot risk model.
        equity += balance.quantity;
      }
    }

    if (nonStable.length) {
      const priced = await Promise.all(
        nonStable.map(async (balance: any) => {
          const symbol = `${balance.asset}USDT`;
          try {
            const quote = await this.http.get('/api/v3/ticker/price', {
              params: { symbol },
              timeout: 5_000,
            });
            const price = Number(quote.data?.price);
            if (!(price > 0) || !Number.isFinite(price)) {
              throw new Error('invalid ticker price');
            }
            return balance.quantity * price;
          } catch {
            return null;
          }
        }),
      );

      if (priced.some(value => value == null)) {
        throw new Error('Binance spot equity incomplete: at least one non-stable asset cannot be marked to USDT');
      }

      equity += priced.reduce((sum, value) => sum + Number(value), 0);
    }

    if (!(equity > 0) || !Number.isFinite(equity)) {
      throw new Error('Binance spot account equity unavailable or invalid');
    }
    return equity;
  }


  async getAllPositions(): Promise<Array<{ symbol: string; positionAmt: number; entryPrice: number; unrealizedProfit: number }>> {
    if (!this.isFutures) return [];
    const res = await this.signedGet('/fapi/v2/positionRisk', {});
    if (!Array.isArray(res)) throw new Error('Binance positionRisk response is not an array');
    return res.map((p: any) => ({
      symbol: String(p.symbol),
      positionAmt: Number(p.positionAmt),
      entryPrice: Number(p.entryPrice),
      unrealizedProfit: Number(p.unRealizedProfit),
    })).filter(p => Number.isFinite(p.positionAmt) && Number.isFinite(p.entryPrice) && Number.isFinite(p.unrealizedProfit));
  }

  async getAllSpotBalancesForConfiguredSymbols(): Promise<any[]> {
    if (this.isFutures) return [];
    const account = await this.signedGet('/api/v3/account', {});
    if (!Array.isArray(account?.balances)) {
      throw new Error('Binance Spot account balances response is invalid');
    }
    return account.balances
      .map((b: any) => ({
        asset: String(b.asset ?? '').toUpperCase(),
        free: Number(b.free ?? 0),
        locked: Number(b.locked ?? 0),
      }))
      .filter((b: any) => b.asset && Number.isFinite(b.free) && Number.isFinite(b.locked) && (b.free > 0 || b.locked > 0));
  }

  // ─── Open orders ────────────────────────────────────────────────────

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params = symbol ? { symbol } : {};
    const result = await this.signedGet(
      this.isFutures ? '/fapi/v1/openOrders' : '/api/v3/openOrders',
      params
    );
    if (!Array.isArray(result)) throw new Error(`Binance openOrders response is not an array${symbol ? ` for ${symbol}` : ''}`);
    return result;
  }

  // ─── Signed HTTP helpers ─────────────────────────────────────────────

  private sign(params: Record<string, unknown>): string {
    const qs  = new URLSearchParams({ ...params, timestamp: Date.now() } as any).toString();
    const sig = crypto
      .createHmac('sha256', this.config.binance.secret)
      .update(qs)
      .digest('hex');
    return `${qs}&signature=${sig}`;
  }

  private async signedPost(path: string, params: Record<string, unknown>): Promise<any> {
    const body = this.sign(params);
    const r    = await this.http.post(`${path}?${body}`);
    return r.data;
  }

  private async signedGet(path: string, params: Record<string, unknown>): Promise<any> {
    const qs = this.sign(params);
    const r  = await this.http.get(`${path}?${qs}`);
    return r.data;
  }

  private async signedDelete(path: string, params: Record<string, unknown>): Promise<any> {
    const qs = this.sign(params);
    const r  = await this.http.delete(`${path}?${qs}`);
    return r.data;
  }

  private formatQty(qty: number, step: number): string {
    const d = Math.max(0, Math.ceil(-Math.log10(step)));
    return qty.toFixed(d);
  }

  private formatPrice(price: number, pip: number): string {
    const d = Math.max(0, Math.ceil(-Math.log10(pip)));
    return price.toFixed(d);
  }
}

