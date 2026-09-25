import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { Logger } from '../utils/Logger';

/** Reads Binance order book depth and returns buy/sell pressure ratio (>1 = buy heavy). */
export class OrderBookAnalyzer {
  private logger = new Logger('OrderBook');
  constructor(private config: SystemConfig) {}

  async pressure(symbol: string): Promise<number> {
    if (this.config.mode !== 'binance') return 1.0;
    try {
      const base = this.config.binance.env === 'testnet'
        ? 'https://testnet.binance.vision/api/v3/depth'
        : 'https://api.binance.com/api/v3/depth';
      const r = await axios.get(base, { params: { symbol, limit: 50 }, timeout: 4000 });
      const bidVol = r.data.bids.reduce((a: number, b: any) => a + Number(b[1]), 0);
      const askVol = r.data.asks.reduce((a: number, b: any) => a + Number(b[1]), 0);
      return askVol > 0 ? bidVol / askVol : 1.0;
    } catch (e: any) { this.logger.warn(e.message); return 1.0; }
  }
}
