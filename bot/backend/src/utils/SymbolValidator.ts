import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { Logger } from './Logger';

/**
 * On startup, verify each symbol is tradeable on the configured broker/data source.
 * Invalid symbols are removed from the active rotation.
 */
export class SymbolValidator {
  private logger = new Logger('SymbolValidator');

  constructor(private config: SystemConfig) {}

  async validate(): Promise<string[]> {
    const valid: string[] = [];

    for (const symbol of this.config.symbols) {
      const source = this.resolveSource(symbol);

      const ok =
        source === 'mt5'
          ? await this.validateMT5(symbol)
          : await this.validateBinance(symbol);

      if (ok) {
        valid.push(symbol);
      } else {
        this.logger.warn(
          `[SymbolValidator] ${symbol} not tradeable - removed from rotation`,
        );
      }
    }

    if (valid.length === 0) {
      this.logger.error('[SymbolValidator] NO valid symbols - bot will not trade!');
    } else {
      this.logger.info(
        `[SymbolValidator] Valid symbols: ${valid.join(', ')}`,
      );
    }

    return valid;
  }

  private async validateMT5(symbol: string): Promise<boolean> {
    try {
      const response = await axios.get(
        `${this.config.mt5.bridgeUrl}/tick`,
        {
          params: { symbol },
          timeout: 4000,
          headers: {
            'X-Api-Key': this.config.mt5.bridgeApiKey ?? '',
          },
        },
      );

      return Number(response.data?.bid) > 0;
    } catch (error: any) {
      this.logger.warn(
        `[MT5] ${symbol} validation failed: ${
          error?.message ?? 'unknown error'
        }`,
      );
      return false;
    }
  }

  private async validateBinance(symbol: string): Promise<boolean> {
    const isFutures = this.config.binance.futures;

    const bases = isFutures
      ? [
          this.config.binance.env === 'testnet'
            ? 'https://testnet.binancefuture.com/fapi/v1'
            : 'https://fapi.binance.com/fapi/v1',
        ]
      : [
          'https://data-api.binance.vision/api/v3',
          'https://api-gcp.binance.com/api/v3',
          'https://api.binance.com/api/v3',
          'https://api1.binance.com/api/v3',
          'https://api2.binance.com/api/v3',
          'https://api3.binance.com/api/v3',
          'https://api4.binance.com/api/v3',
        ];

    const failures: string[] = [];

    for (const base of bases) {
      try {
        const response = await axios.get(
          `${base}/exchangeInfo`,
          {
            params: { symbol },
            timeout: 5000,
          },
        );

        const symbols = response.data?.symbols;

        if (Array.isArray(symbols) && symbols.length > 0) {
          this.logger.info(
            `[Binance] ${symbol} validated via ${base}`,
          );
          return true;
        }

        failures.push(`${base}: empty symbols response`);
      } catch (error: any) {
        const status = error?.response?.status;
        const code = error?.code;
        const message = error?.message ?? 'unknown error';

        failures.push(
          `${base}: ${status ? `HTTP ${status}` : code ?? message}`,
        );
      }
    }

    this.logger.error(
      `[Binance] ${symbol} validation failed on all endpoints: ${failures.join(
        ' | ',
      )}`,
    );

    return false;
  }

  private resolveSource(symbol: string): 'mt5' | 'binance' {
    if (this.config.mode === 'mt5') {
      return 'mt5';
    }

    if (this.config.mode === 'binance') {
      return 'binance';
    }

    if (this.config.dataSource === 'mt5') {
      return 'mt5';
    }

    if (this.config.dataSource === 'binance') {
      return 'binance';
    }

    const normalized = symbol
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '');

    return /(USDT|USDC|BUSD)$/.test(normalized)
      ? 'binance'
      : 'mt5';
  }
}