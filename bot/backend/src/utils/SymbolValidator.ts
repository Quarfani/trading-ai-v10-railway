import axios from 'axios';
import { SystemConfig } from '../types/trading.types';
import { Logger } from './Logger';
import { registerBrokerContract } from '../market/MarketCatalog';
import { AssetClass } from '../market/market.types';
import { BrokerContractDefinition } from '../market/BrokerContractRegistry';

/**
 * On startup, verify each symbol is tradeable on the configured broker/data source.
 * Invalid symbols are removed from the active rotation.
 */
export interface MT5ContractPayload {
  symbol?: string;
  description?: string;
  currency_base?: string;
  currency_profit?: string;
  trade_contract_size?: number;
  point?: number;
  volume_min?: number;
  volume_max?: number;
  volume_step?: number;
  time?: number;
}

export function inferMT5AssetClass(
  symbol: string,
  description = '',
  baseCurrency = '',
  quoteCurrency = '',
): AssetClass | null {
  const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const text = description.toUpperCase();
  const base = baseCurrency.toUpperCase().trim();
  const quote = quoteCurrency.toUpperCase().trim();

  if (
    base === 'XAU' || base === 'XAG' ||
    normalized.startsWith('XAU') || normalized.startsWith('XAG')
  ) return 'METAL';

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
  if (codes.has(base) && codes.has(quote) && base !== quote) return 'FOREX';

  if (normalized.length >= 6) {
    const symbolBase = normalized.slice(0, 3);
    const symbolQuote = normalized.slice(3, 6);
    if (codes.has(symbolBase) && codes.has(symbolQuote)) return 'FOREX';
  }

  return null;
}

export function buildMT5BrokerContractDefinition(
  fallbackSymbol: string,
  data: MT5ContractPayload,
  now = Date.now(),
): BrokerContractDefinition {
  const symbol = String(data?.symbol ?? fallbackSymbol).trim();
  const baseCurrency = String(data?.currency_base ?? '');
  const quoteCurrency = String(data?.currency_profit ?? '');
  const assetClass = inferMT5AssetClass(
    symbol,
    String(data?.description ?? ''),
    baseCurrency,
    quoteCurrency,
  );

  if (!assetClass) throw new Error('unsupported/unknown MT5 asset class');

  return {
    symbol,
    baseAsset: baseCurrency,
    quoteCurrency,
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
    observedAt: Number(data?.time) * 1000 || now,
    expiresAt: now + 24 * 3_600_000,
    verified: true,
  };
}
export class SymbolValidator {
  private logger = new Logger('SymbolValidator');

  constructor(private config: SystemConfig) {}

  /**
   * Refresh broker-confirmed contract economics without changing symbol rotation.
   * Existing registry entries remain usable until their TTL expires; repeated
   * refresh failures therefore cannot silently replace broker data with static
   * assumptions, while an expired contract ultimately blocks live sizing.
   */
  async refreshBrokerContracts(
    symbols: string[] = this.config.symbols,
  ): Promise<{ refreshed: number; failed: string[] }> {
    let refreshed = 0;
    const failed: string[] = [];

    for (const symbol of symbols) {
      if (this.resolveSource(symbol) !== 'mt5') continue;

      try {
        await this.enrichBrokerContract(symbol);
        refreshed += 1;
      } catch (error: any) {
        failed.push(symbol);
        this.logger.warn(
          '[MT5] ' + symbol + ' broker contract refresh failed: ' +
          (error?.message ?? 'unknown'),
        );
      }
    }

    return { refreshed, failed };
  }

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

      if (!tradable) return false;

      try {
        await this.enrichBrokerContract(symbol);
        return true;
      } catch (error: any) {
        this.logger.warn(
          '[MT5] ' + symbol + ' broker contract metadata unavailable: ' +
          (error?.message ?? 'unknown') +
          ' — symbol blocked',
        );
        return false;
      }
    } catch (error: any) {
      this.logger.warn(
        '[MT5] ' + symbol + ' validation failed: ' + (error?.message ?? 'unknown error'),
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
  private async enrichBrokerContract(symbol: string): Promise<void> {
    const response = await axios.get(
      this.config.mt5.bridgeUrl + '/contract',
      {
        params: { symbol },
        timeout: 5000,
        headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey ?? '' },
      },
    );

    registerBrokerContract(
      buildMT5BrokerContractDefinition(symbol, response.data),
    );
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

    registerBrokerContract(
      buildMT5BrokerContractDefinition(symbol, response.data),
    );
  }

}