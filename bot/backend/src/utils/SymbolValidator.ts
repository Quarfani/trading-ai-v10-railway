import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { Logger } from './Logger';

/** On startup, verify each symbol is tradeable on the broker. Drops invalid ones. */
export class SymbolValidator {
  private logger = new Logger('SymbolValidator');
  constructor(private config: SystemConfig) {}

  async validate(): Promise<string[]> {
    const valid: string[] = [];
    for (const s of this.config.symbols) {
      const ok = this.resolveSource(s)==='mt5' ? await this.validateMT5(s) : await this.validateBinance(s);
      if (ok) valid.push(s);
      else this.logger.warn(`❌ ${s} not tradeable — removed from rotation`);
    }
    if (!valid.length) this.logger.error('NO valid symbols — bot will not trade!');
    else this.logger.info(`✅ Valid symbols: ${valid.join(', ')}`);
    return valid;
  }

  private async validateMT5(symbol: string): Promise<boolean> {
    try {
      const r = await axios.get(`${this.config.mt5.bridgeUrl}/tick`,
        { params: { symbol }, timeout: 4000 });
      return r.data?.bid > 0;
    } catch { return false; }
  }

  private async validateBinance(symbol: string): Promise<boolean> {
    const base = this.config.binance.futures
      ? (this.config.binance.env==='testnet' ? 'https://testnet.binancefuture.com/fapi/v1/exchangeInfo' : 'https://fapi.binance.com/fapi/v1/exchangeInfo')
      : (this.config.binance.env==='testnet' ? 'https://testnet.binance.vision/api/v3/exchangeInfo' : 'https://api.binance.com/api/v3/exchangeInfo');
    try {
      const r = await axios.get(base, { params: { symbol }, timeout: 5000 });
      return (r.data?.symbols ?? []).length > 0;
    } catch { return false; }
  }

  private resolveSource(symbol:string): 'mt5'|'binance' {
    if(this.config.mode==='mt5')return 'mt5'; if(this.config.mode==='binance')return 'binance';
    if(this.config.dataSource==='mt5')return 'mt5'; if(this.config.dataSource==='binance')return 'binance';
    return /(USDT|USDC|BUSD)$/.test(symbol.toUpperCase().replace(/[^A-Z0-9]/g,''))?'binance':'mt5';
  }
}
