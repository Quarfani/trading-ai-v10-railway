/**
 * MARKET DOMAIN — canonical cross-asset/timeframe contracts.
 *
 * This module deliberately contains no broker calls and no environment access.
 * It is the common vocabulary for future multi-market expansion.
 */

export const TIMEFRAMES = [
  'M1',
  'M5',
  'M15',
  'M30',
  'H1',
  'H4',
  'D1',
] as const;

export type Timeframe = typeof TIMEFRAMES[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  M1: 60_000,
  M5: 5 * 60_000,
  M15: 15 * 60_000,
  M30: 30 * 60_000,
  H1: 60 * 60_000,
  H4: 4 * 60 * 60_000,
  D1: 24 * 60 * 60_000,
};

export type AssetClass =
  | 'FOREX'
  | 'CRYPTO'
  | 'METAL'
  | 'ENERGY'
  | 'INDEX';

export type ContractType =
  | 'SPOT'
  | 'CFD'
  | 'FUTURE'
  | 'PERPETUAL';

export type MarketVenue =
  | 'BINANCE_SPOT'
  | 'BINANCE_FUTURES'
  | 'MT5';

export type MarginModel =
  | 'NOTIONAL_LEVERAGE'
  | 'BROKER_DEFINED';

export interface MarketEconomics {
  contractType: ContractType;
  contractSize: number;
  priceIncrement: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  marginModel: MarginModel;
}

export interface MarketDefinition {
  symbol: string;
  /** Exact broker symbol when the market originates from broker metadata. */
  brokerSymbol?: string;
  baseAsset: string;
  quoteCurrency: string;
  assetClass: AssetClass;
  supportedVenues: readonly MarketVenue[];
  /** Broker-declared timeframe support; omitted means not explicitly constrained. */
  supportedTimeframes?: readonly Timeframe[];
  economics: MarketEconomics;
}

/**
 * Canonical market identity is intentionally stricter than string parsing.
 * An unsupported/unknown symbol must not inherit a dangerous generic Forex
 * contract size by accident.
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}
