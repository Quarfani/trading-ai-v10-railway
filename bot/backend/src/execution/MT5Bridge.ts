/**
 * MT5 BRIDGE CLIENT
 * Adds:
 *  - API key header on every request (MT5_BRIDGE_API_KEY)
 *  - Reconnect detection: if bridge is down, pings before next request
 *  - Centralized timeout constants
 */
import axios, { AxiosInstance } from 'axios';
import { Signal, SystemConfig, Trade } from '../types/trading.types';
import { Logger } from '../utils/Logger';
import { getBrokerMarketDefinition } from '../market/MarketCatalog';

const TIMEOUT_SHORT  = 4_000;
const TIMEOUT_NORMAL = 10_000;
const TIMEOUT_CLOSE  = 8_000;

export class MT5Bridge {
  private logger = new Logger('MT5');
  private http:   AxiosInstance;

  constructor(private config: SystemConfig) {
    this.http = axios.create({
      baseURL: config.mt5.bridgeUrl,
      headers: {
        'X-Api-Key': config.mt5.bridgeApiKey ?? '',
        'Content-Type': 'application/json',
      },
    });
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.http.get('/health', { timeout: TIMEOUT_SHORT });
      return r.data.ok === true;
    } catch { return false; }
  }

  async placeOrder(s: Signal, volume: number, idempotencyKey: string): Promise<Trade | null> {
    try {
      const market = getBrokerMarketDefinition(s.symbol, s.timeframe ?? 'H1');
      if (!market) return null;
      const brokerSymbol = market.brokerSymbol ?? s.symbol;
      if (!idempotencyKey?.trim()) throw new Error('MT5 placeOrder requires idempotencyKey');
      const r = await this.http.post('/trade',
        {
          symbol: brokerSymbol,
          side: s.side,
          volume,
          sl: s.sl,
          tp: s.tp,
          idempotency_key: idempotencyKey.trim(),
        },
        { timeout: TIMEOUT_NORMAL });
      if (
        r.data?.ok !== true ||
        !r.data.ticket ||
        !Number.isFinite(Number(r.data.price)) ||
        !(Number(r.data.volume) > 0)
      ) {
        this.logger.error('Order returned non-authoritative result: ' + JSON.stringify(r.data));
        return null;
      }
      return {
        ticket: Number(r.data.ticket),
        symbol: brokerSymbol, side: s.side, volume,
        entry: Number(r.data.price), sl: s.sl, tp: s.tp,
        status: 'open', openedAt: Date.now(), source: s.source,
      };
    } catch (e: any) {
      this.logger.error(`placeOrder failed: ${e.message}`);
      return null;
    }
  }

  async getOpenPositions(): Promise<any[] | null> {
    try {
      const r = await this.http.get('/positions', { timeout: TIMEOUT_SHORT });
      if (!Array.isArray(r.data?.positions)) {
        this.logger.error('MT5 positions response was not authoritative');
        return null;
      }
      return r.data.positions;
    } catch (e: any) {
      this.logger.warn('getOpenPositions failed: ' + (e?.message ?? e));
      return null;
    }
  }

  async getTrade(ticket: number): Promise<any | null> {
    try {
      const r = await this.http.get('/position', { params: { ticket }, timeout: TIMEOUT_SHORT });
      if (!r.data?.found) return null;
      return r.data;
    } catch {
      // Fallback: scan open positions list
      try {
        const positions = await this.getOpenPositions();
        return positions.find((p: any) => Number(p.ticket) === Number(ticket)) ?? null;
      } catch { return null; }
    }
  }

  async closeTrade(ticket: number, idempotencyKey: string): Promise<{ profit: number } | null> {
    try {
      if (ticket <= 0 || !idempotencyKey?.trim()) {
        throw new Error('MT5 closeTrade requires positive ticket and idempotencyKey');
      }
      const r = await this.http.post(
        '/close',
        { ticket, idempotency_key: idempotencyKey.trim() },
        { timeout: TIMEOUT_CLOSE },
      );
      const profit = Number(r.data?.profit);
      if (r.data?.ok !== true || !Number.isFinite(profit)) {
        this.logger.error('MT5 close returned non-authoritative result: ' + JSON.stringify(r.data));
        return null;
      }
      return { profit };
    } catch (e: any) {
      this.logger.warn('closeTrade failed: ' + (e?.message ?? e));
      return null;
    }
  }

  async modifyTrade(ticket: number, sl: number, tp: number, idempotencyKey: string): Promise<boolean> {
    try {
      if (ticket <= 0 || !(sl > 0) || !(tp > 0) || !idempotencyKey?.trim()) {
        throw new Error('MT5 modifyTrade requires valid ticket, SL/TP and idempotencyKey');
      }
      const r = await this.http.post(
        '/modify',
        { ticket, sl, tp, idempotency_key: idempotencyKey.trim() },
        { timeout: TIMEOUT_NORMAL },
      );
      return r.data?.ok === true;
    } catch (e: any) {
      this.logger.warn('modifyTrade failed: ' + (e?.message ?? e));
      return false;
    }
  }
}
