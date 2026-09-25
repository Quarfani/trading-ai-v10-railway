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
    await this.signedPost(this.isFutures ? '/fapi/v1/order' : '/api/v3/order', {
      symbol: signal.symbol,
      side: closeSide,
      type: 'MARKET',
      quantity: this.formatQty(quantity, spec.volumeStep),
      ...(this.isFutures ? { reduceOnly: 'true' } : {}),
    });
    this.logger.error(`[Binance] Emergency close submitted after protection failure: ${signal.symbol}`);
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
      const ticket    = Number(entry.orderId);

      this.logger.info(
        `[Binance] Entry: ${signal.side} ${quantity} ${signal.symbol} ` +
        `@ ${fillPrice} ticket=${ticket}`
      );

      // 2. Protective orders are fail-safe: the trade is NOT accepted unless
      //    SL+TP (or Spot OCO) are confirmed. If protection fails, attempt an
      //    immediate market close so we never knowingly continue unprotected.
      try {
        if (this.isFutures) {
          await this.placeSLTP(signal, quantity, ticket, spec);
        } else {
          await this.placeOCO(signal, quantity, ticket, spec);
        }
      } catch (protectionError: any) {
        this.logger.error(`CRITICAL: protective orders failed for ${signal.symbol}: ${protectionError?.message ?? protectionError}`);
        const emergencyError = await this.emergencyCloseAfterProtectionFailure(signal, quantity).catch(e => e);
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
        volume:   quantity,
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
          this.logger.warn(`[Binance] Recovered ambiguous order ${clientOrderId} as ticket=${recoveredTicket}`);
          try {
            if (this.isFutures) await this.placeSLTP(signal, quantity, recoveredTicket, getSymbolSpec(signal.symbol));
            else await this.placeOCO(signal, quantity, recoveredTicket, getSymbolSpec(signal.symbol));
          } catch (protectionError: any) {
            const emergencyError = await this.emergencyCloseAfterProtectionFailure(signal, quantity).catch(e => e);
            if (emergencyError) throw new Error(`Recovered order protection failed and emergency close failed: ${protectionError?.message ?? protectionError}`);
            if (this.isFutures) {
              const remaining = await this.getPosition(signal.symbol);
              if (remaining && Math.abs(remaining.positionAmt) > 0) throw new Error(`Recovered order remained unprotected: ${signal.symbol}`);
            }
            return null;
          }
          return {ticket: recoveredTicket, symbol: signal.symbol, side: signal.side, volume: quantity, entry: fillPriceRecovered, sl: signal.sl, tp: signal.tp, status:'open', openedAt: Date.now(), source: signal.source};
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

  async modifyPosition(ticket:number,symbol:string,side:'BUY'|'SELL',newSl:number,newTp:number):Promise<boolean>{
    if(!this.isFutures)return false;
    try{
      const ids=this.orderMap.get(ticket);
      for(const orderId of [ids?.slOrderId,ids?.tpOrderId]) if(orderId) await this.signedDelete('/fapi/v1/order',{symbol,orderId}).catch(()=>{});
      const quantity=ids?.quantity ?? Math.abs((await this.getPosition(symbol))?.positionAmt ?? 0);
      if(!(quantity>0)) return false;
      const sig={symbol,side,price:0,confidence:1,sl:newSl,tp:newTp,source:'modify',reason:'modify',timestamp:Date.now()} as Signal;
      await this.placeSLTP(sig,quantity,ticket,getSymbolSpec(symbol));
      return true;
    }catch(e:any){this.logger.warn(`modifyPosition failed: ${e?.message??e}`);return false;}}

  async closePartialPosition(ticket:number,symbol:string,volume:number):Promise<boolean>{
    if(!this.isFutures || !(volume>0)) return false;
    try{
      const pos=await this.getPosition(symbol);
      if(!pos || pos.positionAmt===0) return false;
      const available=Math.abs(pos.positionAmt);
      const qty=Math.min(volume,available);
      if(!(qty>0)) return false;
      const closeSide=pos.positionAmt>0?'SELL':'BUY';
      await this.signedPost('/fapi/v1/order',{symbol,side:closeSide,type:'MARKET',quantity:this.formatQty(qty,getSymbolSpec(symbol).volumeStep),reduceOnly:'true'});
      const ids=this.orderMap.get(ticket);
      if(ids) ids.quantity=Math.max(0,(ids.quantity??available)-qty);
      this.logger.info(`[Binance] Partial close ${symbol} ${qty}`);
      return true;
    }catch(e:any){this.logger.error(`closePartialPosition failed: ${e?.message??e}`);return false;}
  }

  // ─── Close position ───────────────────────────────────────────────────

  async closePosition(ticket: number, symbol: string, volume?: number): Promise<boolean> {
    try {
      // Cancel SL/TP first
      const ids = this.orderMap.get(ticket);
      if (ids) {
        for (const orderId of [ids.slOrderId, ids.tpOrderId]) {
          if (orderId) {
            await this.signedDelete(
              this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
              { symbol, orderId }
            ).catch(() => {});
          }
        }
        this.orderMap.delete(ticket);
      }

      if (this.isFutures) {
        const pos=await this.getPosition(symbol); if(!pos||pos.positionAmt===0)return true;
        const closeQty=volume??Math.abs(pos.positionAmt); const closeSide=pos.positionAmt>0?'SELL':'BUY';
        await this.signedPost('/fapi/v1/order',{symbol,side:closeSide,type:'MARKET',quantity:this.formatQty(Math.abs(closeQty),getSymbolSpec(symbol).volumeStep),reduceOnly:'true'});
      } else {
        const closeSide=ids?.closeSide, closeQty=volume??ids?.quantity;
        if(!closeSide||!closeQty) return false;
        await this.signedPost('/api/v3/order',{symbol,side:closeSide,type:'MARKET',quantity:this.formatQty(closeQty,getSymbolSpec(symbol).volumeStep)});
      }
      this.logger.info(`[Binance] Closed position ${symbol} ticket=${ticket}`); return true;

    } catch (e: any) {
      this.logger.error(`closePosition failed: ${e.message}`);
      return false;
    }
  }

  // ─── Get position ────────────────────────────────────────────────────

  async getPosition(symbol: string): Promise<{ positionAmt: number; entryPrice: number; unrealizedProfit: number } | null> {
    const res = await this.signedGet('/fapi/v2/positionRisk', { symbol });
    const pos = Array.isArray(res) ? res.find((p: any) => p.symbol === symbol) : res;
    if (!pos) return null;
    const positionAmt = Number(pos.positionAmt);
    const entryPrice = Number(pos.entryPrice);
    const unrealizedProfit = Number(pos.unRealizedProfit);
    if (![positionAmt, entryPrice, unrealizedProfit].every(Number.isFinite))
      throw new Error(`Binance returned invalid position metadata for ${symbol}`);
    return { positionAmt, entryPrice, unrealizedProfit };
  }

  // ─── Account equity ──────────────────────────────────────────────────

  async accountEquity(): Promise<number> {
    if (this.isFutures) {
      const r = await this.signedGet('/fapi/v2/account', {});
      const equity = Number(r.totalWalletBalance);
      if (!(equity > 0) || !Number.isFinite(equity)) throw new Error('Binance futures equity unavailable or invalid');
      return equity;
    }
    const r = await this.signedGet('/api/v3/account', {});
    const usdt = (r.balances as any[]).find((b: any) => b.asset === 'USDT');
    const equity = usdt ? Number(usdt.free) + Number(usdt.locked) : NaN;
    if (!(equity > 0) || !Number.isFinite(equity)) throw new Error('Binance USDT equity unavailable or invalid');
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
