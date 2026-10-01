import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { Logger } from './Logger';
import { registerBrokerContract } from '../market/MarketCatalog';
import { AssetClass } from '../market/market.types';

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
        this.config.mt5.bridgeUrl + '/tick',
        {
          params: { symbol },
          timeout: 4000,
          headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey ?? '' },
        },
      );

      const tradable = Number(response.data?.bid) > 0;

      if (tradable) {
        await this.enrichBrokerContract(symbol).catch((error: any) => {
          this.logger.debug(
            '[MT5] ' + symbol + ' contract metadata unavailable: ' + (error?.message ?? 'unknown'),
          );
        });
      }

      return tradable;
    } catch (error: any) {
      this.logger.warn(
        '[MT5] ' + symbol + ' validation failed: ' + (error?.message ?? 'unknown error'),
      );
      return false;
    }
  }

  private inferMT5AssetClass(symbol: string, description: string): AssetClass | null {
    const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const text = (description ?? '').toUpperCase();

    if (normalized === 'XAUUSD' || normalized === 'XAGUSD') return 'METAL';
    if (
      normalized.includes('OIL') || normalized.includes('WTI') ||
      normalized.includes('BRENT') || normalized.includes('XTI') ||
      normalized.includes('XBR') || text.includes('OIL') ||
      text.includes('WTI') || text.includes('BRENT')
    ) return 'ENERGY';

    if (['US30','SPX500','NAS100','GER40','US500','UK100','DE40'].includes(normalized)) {
      return 'INDEX';
    }

    const codes = new Set(['USD','EUR','GBP','JPY','AUD','NZD','CAD','CHF']);
    if (normalized.length === 6) {
      const base = normalized.slice(0, 3);
      const quote = normalized.slice(3, 6);
      if (codes.has(base) && codes.has(quote)) return 'FOREX';
    }
    return null;
  }

  private async enrichBrokerContract(symbol: string): Promise<void> {
    const response = await axios.get(
      this.config.mt5.bridgeUrl + '/contract',
      {
        params: { symbol },
        timeout: 5000,
        headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey ?? '' },
      },
    );

    const data = response.data;
    const assetClass = this.inferMT5AssetClass(
      String(data?.symbol ?? symbol),
      String(data?.description ?? ''),
    );
    if (!assetClass) return;

    registerBrokerContract({
      symbol: String(data?.symbol ?? symbol),
      baseAsset: String(data?.currency_base ?? ''),
      quoteCurrency: String(data?.currency_profit ?? ''),
      assetClass,
      contractType: 'CFD',
      venue: 'MT5',
      contractSize: Number(data?.trade_contract_size),
      priceIncrement: Number(data?.point),
      minVolume: Number(data?.volume_min),
      maxVolume: Number(data?.volume_max),
      volumeStep: Number(data?.volume_step),
      marginModel: 'BROKER_DEFINED',
      source: 'MT5:symbol_info',
      observedAt: Number(data?.time) * 1000 || Date.now(),
      expiresAt: Date.now() + 24 * 3_600_000,
      verified: true,
    });
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