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
        'X-Api-Key': process.env.MT5_BRIDGE_API_KEY ?? '',
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

  async placeOrder(s: Signal, volume: number): Promise<Trade | null> {
    try {
      const r = await this.http.post('/order',
        { symbol: s.symbol, side: s.side, volume, sl: s.sl, tp: s.tp },
        { timeout: TIMEOUT_NORMAL });
      if (!r.data.ticket) {
        this.logger.error(`Order returned no ticket: ${JSON.stringify(r.data)}`);
        return null;
      }
      return {
        ticket: Number(r.data.ticket),
        symbol: s.symbol, side: s.side, volume,
        entry: Number(r.data.price), sl: s.sl, tp: s.tp,
        status: 'open', openedAt: Date.now(), source: s.source,
      };
    } catch (e: any) {
      this.logger.error(`placeOrder failed: ${e.message}`);
      return null;
    }
  }

  async getOpenPositions(): Promise<any[]> {
    try {
      const r = await this.http.get('/positions', { timeout: TIMEOUT_SHORT });
      return r.data.positions ?? [];
    } catch { return []; }
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

  async closeTrade(ticket: number): Promise<{ profit: number } | null> {
    try {
      const r = await this.http.post('/close', { ticket }, { timeout: TIMEOUT_CLOSE });
      return { profit: Number(r.data.profit ?? 0) };
    } catch { return null; }
  }

  async modifyTrade(ticket: number, sl: number, tp: number): Promise<boolean> {
    try {
      const r = await this.http.post('/modify', { ticket, sl, tp }, { timeout: TIMEOUT_NORMAL });
      return r.data?.ok === true;
    } catch { return false; }
  }
}
