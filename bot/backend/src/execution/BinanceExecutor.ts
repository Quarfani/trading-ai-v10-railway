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
  closeSide?: 'BUY'|'SELL';
  quantity?: number;
}

export function makeBinanceClientOrderId(operationKey: string): string {
  const digest = crypto.createHash('sha256').update(operationKey).digest('hex').slice(0, 28);
  return `ta_${digest}`.slice(0, 36);
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

  private async emergencyCloseAfterProtectionFailure(signal: Signal, quantity: number): Promise<void> {
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const spec = getSymbolSpec(signal.symbol);
    const result = await this.signedPost(
      this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
      {
        symbol: signal.symbol,
        side: closeSide,
        type: 'MARKET',
        quantity: this.formatQty(quantity, spec.volumeStep),
        ...(this.isFutures ? { reduceOnly: 'true' } : {}),
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

    this.logger.error(
      `[Binance] Emergency close filled after protection failure: ${signal.symbol} qty=${executed}`,
    );
  }

  private async getFuturesOrderNetPnl(
    symbol: string,
    orderId: number,
  ): Promise<{ profit: number; currency: string } | null> {
    if (!this.isFutures || !(orderId > 0)) return null;

    const fills = await this.signedGet('/fapi/v1/userTrades', {
      symbol,
      orderId,
    });

    if (!Array.isArray(fills) || fills.length === 0) return null;

    let net = 0;
    let currency = '';

    for (const fill of fills) {
      const realizedPnl = Number(fill?.realizedPnl);
      const commission = Number(fill?.commission);
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
    }

    if (!currency || !Number.isFinite(net)) return null;
    return { profit: net, currency };
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

      const fillPrice = Number(entry.avgPrice ?? entry.fills?.[0]?.price ?? signal.price);
      const executedQty = Number(entry.executedQty ?? entry.origQty ?? quantity);
      const ticket = Number(entry.orderId);
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
          await this.placeSLTP(signal, executedQty, ticket, spec);
        } else {
          await this.placeOCO(signal, executedQty, ticket, spec);
        }
      } catch (protectionError: any) {
        this.logger.error(`CRITICAL: protective orders failed for ${signal.symbol}: ${protectionError?.message ?? protectionError}`);
        const emergencyError = await this.emergencyCloseAfterProtectionFailure(signal, executedQty).catch(e => e);
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
        symbol:   signal.symbol,
        side:     signal.side,
        volume:   executedQty,
        entry:    fillPrice,
        sl:       signal.sl,
        tp:       signal.tp,
        status:   'open',
        openedAt: Date.now(),
        source:   signal.source,
      };

    } catch (e: any) {
      if (clientOrderId) {
        const recovered = await this.findOrderByClientId(signal.symbol, clientOrderId);
        if (recovered && !['CANCELED','REJECTED','EXPIRED'].includes(String(recovered.status ?? '').toUpperCase())) {
          const recoveredTicket = Number(recovered.orderId);
          const fillPriceRecovered = Number(recovered.avgPrice ?? recovered.fills?.[0]?.price ?? signal.price);
          const executedQtyRecovered = Number(recovered.executedQty ?? recovered.origQty ?? quantity);
          if (!(executedQtyRecovered > 0) || !Number.isFinite(executedQtyRecovered)) {
            throw new Error('Recovered Binance order returned invalid executed quantity');
          }
          this.logger.warn(`[Binance] Recovered ambiguous order ${clientOrderId} as ticket=${recoveredTicket}`);
          try {
            if (this.isFutures) await this.placeSLTP(signal, executedQtyRecovered, recoveredTicket, getSymbolSpec(signal.symbol));
            else await this.placeOCO(signal, executedQtyRecovered, recoveredTicket, getSymbolSpec(signal.symbol));
          } catch (protectionError: any) {
            const emergencyError = await this.emergencyCloseAfterProtectionFailure(signal, executedQtyRecovered).catch(e => e);
            if (emergencyError) throw new Error(`Recovered order protection failed and emergency close failed: ${protectionError?.message ?? protectionError}`);
            if (this.isFutures) {
              const remaining = await this.getPosition(signal.symbol);
              if (remaining && Math.abs(remaining.positionAmt) > 0) throw new Error(`Recovered order remained unprotected: ${signal.symbol}`);
            }
            return null;
          }
          return {ticket: recoveredTicket, symbol: signal.symbol, side: signal.side, volume: executedQtyRecovered, entry: fillPriceRecovered, sl: signal.sl, tp: signal.tp, status:'open', openedAt: Date.now(), source: signal.source};
        }
      }
      this.logger.error(`placeMarketOrder failed: ${e.response?.data ?? e.message}`);
      return null;
    }
  }

  // ─── [FIX-1] Futures SL + TP orders ──────────────────────────────────

  private async placeSLTP(
    signal:   Signal,
    quantity: number,
    ticket:   number,
    spec:     ReturnType<typeof getSymbolSpec>,
  ): Promise<void> {
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const qty       = this.formatQty(quantity, spec.volumeStep);
    const slPrice   = this.formatPrice(signal.sl, spec.pip);
    const tpPrice   = this.formatPrice(signal.tp, spec.pip);

    const ids: OpenOrderIds = {};

    // Stop Loss
    try {
      const slOrder = await this.signedPost('/fapi/v1/order', {
        symbol:           signal.symbol,
        side:             closeSide,
        type:             'STOP_MARKET',
        stopPrice:        slPrice,
        closePosition:    'true',
        workingType:      'MARK_PRICE',
      });
      ids.slOrderId = Number(slOrder.orderId);
      this.logger.info(
        `[Binance] SL placed: ${signal.symbol} stopPrice=${slPrice} orderId=${ids.slOrderId}`
      );
    } catch (e: any) {
      throw new Error(`SL placement failed: ${e.response?.data?.msg ?? e.message}`);
    }

    // Take Profit
    try {
      const tpOrder = await this.signedPost('/fapi/v1/order', {
        symbol:           signal.symbol,
        side:             closeSide,
        type:             'TAKE_PROFIT_MARKET',
        stopPrice:        tpPrice,
        closePosition:    'true',
        workingType:      'MARK_PRICE',
      });
      ids.tpOrderId = Number(tpOrder.orderId);
      this.logger.info(
        `[Binance] TP placed: ${signal.symbol} stopPrice=${tpPrice} orderId=${ids.tpOrderId}`
      );
    } catch (e: any) {
      if (ids.slOrderId) await this.signedDelete('/fapi/v1/order', {symbol: signal.symbol, orderId: ids.slOrderId}).catch(() => {});
      throw new Error(`TP placement failed: ${e.response?.data?.msg ?? e.message}`);
    }

    ids.closeSide=closeSide; ids.quantity=quantity;
    this.orderMap.set(ticket, ids);
  }

  // ─── Spot OCO (SL + TP combined) ─────────────────────────────────────

  private async placeOCO(
    signal:   Signal,
    quantity: number,
    ticket:   number,
    spec:     ReturnType<typeof getSymbolSpec>,
  ): Promise<void> {
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';

    // OCO: price=TP (limit), stopPrice=SL (stop-limit trigger), stopLimitPrice=SL-buffer
    const tpPrice   = this.formatPrice(signal.tp, spec.pip);
    const slPrice   = this.formatPrice(signal.sl, spec.pip);
    const slLimit   = signal.side === 'BUY'
      ? this.formatPrice(signal.sl * 0.9995, spec.pip)  // small buffer
      : this.formatPrice(signal.sl * 1.0005, spec.pip);

    // Binance's current Spot REST API uses the order-list OCO endpoint; the legacy /api/v3/order/oco route is deprecated.
    const baseId = `ta${ticket}`.slice(0, 12);
    const oco = await this.signedPost('/api/v3/orderList/oco', {
      symbol:            signal.symbol,
      side:              closeSide,
      quantity:          this.formatQty(quantity, spec.volumeStep),
      listClientOrderId: `${baseId}l`,
      aboveClientOrderId: `${baseId}a`,
      belowClientOrderId: `${baseId}b`,
      aboveType:         'LIMIT_MAKER',
      abovePrice:        tpPrice,
      belowType:         'STOP_LOSS_LIMIT',
      belowStopPrice:    slPrice,
      belowPrice:        slLimit,
      belowTimeInForce:  'GTC',
    });

    const reports = Array.isArray(oco.orderReports) ? oco.orderReports : [];
    if (reports.length < 2) throw new Error('Binance Spot OCO accepted without two order reports');
    this.logger.info(
      `[Binance Spot] OCO placed: ${signal.symbol} TP=${tpPrice} SL=${slPrice}`
    );
    const tpReport = reports.find((r: any) => String(r.type).includes('LIMIT') || r.clientOrderId === `${baseId}a`);
    const slReport = reports.find((r: any) => String(r.type).includes('STOP') || r.clientOrderId === `${baseId}b`);
    this.orderMap.set(ticket, {
      slOrderId: slReport?.orderId,
      tpOrderId: tpReport?.orderId,
      closeSide, quantity,
    });
  }

  // ─── Modify SL/TP ─────────────────────────────────────────────────────

  async modifyPosition(
    ticket:number,
    symbol:string,
    side:'BUY'|'SELL',
    newSl:number,
    newTp:number,
  ):Promise<boolean>{
    if(!this.isFutures)return false;
    try{
      const ids=this.orderMap.get(ticket);
      const oldIds=[ids?.slOrderId,ids?.tpOrderId].filter(
        (id): id is number => Number.isFinite(id),
      );

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

      const quantity=ids?.quantity ?? Math.abs(
        (await this.getPosition(symbol))?.positionAmt ?? 0,
      );
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
      });

      const orderId=Number(order?.orderId);
      if(!(orderId>0) || !Number.isFinite(orderId)) {
        throw new Error('Binance partial close returned invalid orderId');
      }

      const after=await this.getPosition(symbol);
      const remainingVolume=Math.max(0,Math.abs(after?.positionAmt??0));

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
  ): Promise<{
    ok: boolean;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  }> {
    let realizedProfit: number | null = null;
    let realizedProfitCurrency: string | null = null;

    try {
      const ids = this.orderMap.get(ticket);
      if (ids) {
        const oldOrderIds = [ids.slOrderId, ids.tpOrderId].filter(
          (id): id is number => Number.isFinite(id),
        );

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
      }

      if (this.isFutures) {
        const pos = await this.getPosition(symbol);
        if (!pos || pos.positionAmt === 0) {
          return {
            ok: true,
            realizedProfit: 0,
            realizedProfitCurrency: null,
          };
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

        await this.signedPost('/api/v3/order', {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: this.formatQty(
            closeQty,
            getSymbolSpec(symbol).volumeStep,
          ),
          ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
        });
      }

      return {
        ok:true,
        realizedProfit:this.isFutures ? realizedProfit : null,
        realizedProfitCurrency:this.isFutures
          ? realizedProfitCurrency
          : null,
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


  async reconcileFuturesCloseByClientOrderId(
    symbol: string,
    clientOrderId: string,
  ): Promise<{
    found: boolean;
    status?: string;
    orderId?: number;
    executedQty?: number;
    realizedProfit?: number | null;
    realizedProfitCurrency?: string | null;
  }> {
    if (!this.isFutures || !clientOrderId) return { found: false };

    const order = await this.findOrderByClientId(symbol, clientOrderId);
    if (!order) return { found: false };

    const status = String(order.status ?? '').toUpperCase();
    const orderId = Number(order.orderId);
    const executedQty = Number(order.executedQty ?? 0);

    if (!(orderId > 0) || !Number.isFinite(orderId)) {
      return {
        found: true,
        status,
        executedQty: Number.isFinite(executedQty) ? executedQty : 0,
      };
    }

    const realized = ['FILLED', 'PARTIALLY_FILLED'].includes(status)
      ? await this.getFuturesOrderNetPnl(symbol, orderId)
      : null;

    return {
      found: true,
      status,
      orderId,
      executedQty: Number.isFinite(executedQty) ? executedQty : 0,
      realizedProfit: realized?.profit ?? null,
      realizedProfitCurrency: realized?.currency ?? null,
    };
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
