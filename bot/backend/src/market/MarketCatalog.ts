/**
 * MARKET CATALOG — fail-closed symbol identity.
 *
 * This catalog is intentionally limited to symbols whose current repository
 * configuration provides concrete contract economics. New asset classes such
 * as Oil must be added with broker-confirmed contract specifications instead
 * of inheriting the generic Forex defaults.
 */

import {
  AssetClass,
  MarketDefinition,
  MarketVenue,
  Timeframe,
  normalizeSymbol,
} from './market.types';
import { getSymbolSpec, isConfiguredSymbol } from '../config/symbolConfig';
import { BrokerContractDefinition, BrokerContractRegistry } from './BrokerContractRegistry';

const STABLE_QUOTES = ['USDT', 'USDC', 'BUSD'] as const;

const METAL_SYMBOLS = new Set([
  'XAUUSD',
  'XAGUSD',
]);

const INDEX_SYMBOLS = new Set([
  'US30',
  'SPX500',
  'NAS100',
  'GER40',
]);

const BROKER_CONTRACTS = new BrokerContractRegistry();

const KNOWN_FOREX_CODES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF',
]);

function inferAssetClass(symbol: string): AssetClass | null {
  if (isConfiguredSymbol(symbol) && STABLE_QUOTES.some(quote => symbol.endsWith(quote))) return 'CRYPTO';
  if (METAL_SYMBOLS.has(symbol)) return 'METAL';
  if (INDEX_SYMBOLS.has(symbol)) return 'INDEX';

  if (symbol.length === 6) {
    const base = symbol.slice(0, 3);
    const quote = symbol.slice(3, 6);
    if (KNOWN_FOREX_CODES.has(base) && KNOWN_FOREX_CODES.has(quote)) {
      return 'FOREX';
    }
  }

  return null;
}

function inferVenues(assetClass: AssetClass): readonly MarketVenue[] {
  switch (assetClass) {
    case 'CRYPTO':
      return ['BINANCE_SPOT', 'BINANCE_FUTURES'];
    case 'FOREX':
    case 'METAL':
    case 'INDEX':
      return ['MT5'];
  }
}

export function registerBrokerContract(definition: BrokerContractDefinition): void {
  BROKER_CONTRACTS.register(definition);
}

export function clearBrokerContracts(): void {
  BROKER_CONTRACTS.clear();
}

export function getBrokerContractStatus(symbols?: string[]) {
  return BROKER_CONTRACTS.status(symbols);
}

export function getBrokerConversionSymbols(
  baseCurrency: string,
  quoteCurrency: string,
): string[] {
  return BROKER_CONTRACTS.findSymbolsByCurrencies(
    baseCurrency,
    quoteCurrency,
  );
}

export function getMarketDefinition(symbol: string, timeframe: Timeframe = 'H1'): MarketDefinition | null {
  const raw = symbol.trim().toUpperCase();

  // Broker metadata must be looked up using the exact broker symbol first.
  // Never normalize away MT5 suffixes such as ".a" or ".raw".
  const brokerDefinition = BROKER_CONTRACTS.getMarketDefinition(raw);
  if (brokerDefinition) return brokerDefinition;

  const normalized = normalizeSymbol(symbol);

  // A non-canonical symbol without broker metadata is unsafe to size: falling
  // back to EURUSD/XAUUSD static economics could silently size the wrong CFD.
  if (raw !== normalized) return null;
  const assetClass = inferAssetClass(normalized);

  if (!assetClass) return null;

  const spec = getSymbolSpec(normalized, timeframe);

  if (
    !Number.isFinite(spec.contractSize) ||
    spec.contractSize <= 0 ||
    !Number.isFinite(spec.minVolume) ||
    !Number.isFinite(spec.maxVolume) ||
    spec.maxVolume < spec.minVolume ||
    !Number.isFinite(spec.volumeStep) ||
    spec.volumeStep <= 0 ||
    !Number.isFinite(spec.pip) ||
    spec.pip <= 0
  ) {
    return null;
  }

  let baseAsset: string;
  let quoteCurrency: string;

  if (assetClass === 'FOREX') {
    baseAsset = normalized.slice(0, 3);
    quoteCurrency = normalized.slice(3, 6);
  } else if (assetClass === 'METAL') {
    baseAsset = normalized.startsWith('XAU') ? 'XAU' : 'XAG';
    quoteCurrency = normalized.slice(3, 6);
  } else if (assetClass === 'CRYPTO') {
    quoteCurrency = normalized.endsWith('USDT')
      ? 'USDT'
      : normalized.endsWith('USDC')
        ? 'USDC'
        : normalized.endsWith('BUSD')
          ? 'BUSD'
          : '';
    baseAsset = quoteCurrency ? normalized.slice(0, -quoteCurrency.length) : normalized;
  } else {
    baseAsset = normalized;
    quoteCurrency = 'USD';
  }

  if (!baseAsset || !quoteCurrency) return null;

  return {
    symbol: normalized,
    baseAsset,
    quoteCurrency,
    assetClass,
    supportedVenues: inferVenues(assetClass),
    economics: {
      contractType: assetClass === 'CRYPTO'
        ? 'PERPETUAL'
        : assetClass === 'FOREX' || assetClass === 'METAL' || assetClass === 'INDEX'
          ? 'CFD'
          : 'CFD',
      contractSize: spec.contractSize,
      priceIncrement: spec.pip,
      minVolume: spec.minVolume,
      maxVolume: spec.maxVolume,
      volumeStep: spec.volumeStep,
      marginModel: 'NOTIONAL_LEVERAGE',
    },
  };
}

export function getBrokerMarketDefinition(
  symbol: string,
  timeframe: Timeframe = 'H1',
): MarketDefinition | null {
  const raw = symbol.trim().toUpperCase();
  const brokerDefinition = BROKER_CONTRACTS.getMarketDefinition(raw);
  if (!brokerDefinition) return null;

  if (
    brokerDefinition.supportedTimeframes &&
    !brokerDefinition.supportedTimeframes.includes(timeframe)
  ) {
    return null;
  }

  return brokerDefinition;
}

export function requireMarketDefinition(symbol: string, timeframe: Timeframe = 'H1'): MarketDefinition {
  const market = getMarketDefinition(symbol, timeframe);
  if (!market) {
    throw new Error(
      `[MarketCatalog] Unsupported or incomplete market definition for "${symbol}". ` +
      'Add broker-confirmed contract economics before enabling it.',
    );
  }
  return market;
}
