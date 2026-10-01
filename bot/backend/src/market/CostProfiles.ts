/**
 * VERSIONED DEFAULT COST PROFILES
 *
 * These are explicit repository assumptions, not broker guarantees.
 * Live/testnet profiles should later be loaded from verified venue metadata.
 */
import { COST_MODEL_VERSION, CostProfile } from './CostModel';
import { getSymbolSpec } from '../config/symbolConfig';

const FIXED_ROUND_TRIP_ACCOUNT: Record<string, number> = {
  EURUSD: 7, GBPUSD: 7, AUDUSD: 7, NZDUSD: 7,
  USDCAD: 7, USDCHF: 7, USDJPY: 7,
  EURGBP: 7, EURJPY: 7, GBPJPY: 7,
  XAUUSD: 10, XAGUSD: 8,
  US30: 5, NAS100: 5, SPX500: 5, GER40: 5,
};

const CRYPTO_NOTIONAL_RATE_PER_SIDE = 0.001;

const CRYPTO = new Set([
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
]);

export function getCostProfile(symbol: string): CostProfile {
  const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const spec = getSymbolSpec(normalized);

  return {
    version: COST_MODEL_VERSION,
    commission: {
      fixedRoundTripPerVolumeAccount:
        FIXED_ROUND_TRIP_ACCOUNT[normalized] ?? 0,
      notionalRatePerSide:
        CRYPTO.has(normalized) ? CRYPTO_NOTIONAL_RATE_PER_SIDE : 0,
    },
    spreadPricePerSide:
      spec.spreadMaxPips * 0.6 * spec.pip,
    marketImpactBpsPerSide: 0,
    holdingRatePerDay: 0,
  };
}
