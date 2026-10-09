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

export interface CostProfileOptions {
  priceIncrement?: number;
  requireExplicit?: boolean;
}

function readEnvNumber(key: string): number | undefined {
  const raw = process.env[key];
  if (raw == null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[CostProfiles] ${key} must be finite and >= 0`);
  }
  return value;
}

export function getCostProfile(
  symbol: string,
  options: CostProfileOptions = {},
): CostProfile {

  const normalized = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const spec = getSymbolSpec(normalized);
  const envPrefix = `COST_${normalized}_`;

  const explicit = {
    spreadPips: readEnvNumber(envPrefix + 'SPREAD_PIPS'),
    fixedRoundTrip: readEnvNumber(envPrefix + 'FIXED_ROUND_TRIP'),
    notionalRate: readEnvNumber(envPrefix + 'NOTIONAL_RATE'),
    impactBps: readEnvNumber(envPrefix + 'IMPACT_BPS'),
    holdingRatePerDay: readEnvNumber(envPrefix + 'HOLDING_RATE_DAY'),
  };

  const explicitValues = Object.values(explicit);
  const hasAnyExplicit = explicitValues.some(value => value != null);
  const hasCompleteExplicitProfile = explicitValues.every(value => value != null);
  if (options.requireExplicit) {
    const missing = Object.entries(explicit)
      .filter(([, value]) => value == null)
      .map(([key]) => key);

    if (missing.length) {
      throw new Error(
        `[CostProfiles] Explicit cost profile required for ${normalized}; missing: ${missing.join(', ')}`,
      );
    }
  }

  const fixedRoundTrip =
    explicit.fixedRoundTrip ??
    FIXED_ROUND_TRIP_ACCOUNT[normalized] ??
    0;

  const notionalRate =
    explicit.notionalRate ??
    (CRYPTO.has(normalized) ? CRYPTO_NOTIONAL_RATE_PER_SIDE : 0);

  const spreadPips =
    explicit.spreadPips ??
    spec.spreadMaxPips;

  const priceIncrement =
    options.priceIncrement ?? spec.pip;

  if (!(priceIncrement > 0) || !Number.isFinite(priceIncrement)) {
    throw new Error(`[CostProfiles] Invalid price increment for ${normalized}`);
  }

  return {
    version: COST_MODEL_VERSION,
    commission: {
      fixedRoundTripPerVolumeAccount: fixedRoundTrip,
      notionalRatePerSide: notionalRate,
    },
    spreadPricePerSide: spreadPips * 0.6 * priceIncrement,
    marketImpactBpsPerSide: explicit.impactBps ?? 0,
    holdingRatePerDay: explicit.holdingRatePerDay ?? 0,
    source: hasCompleteExplicitProfile ? 'ENV_EXPLICIT' : hasAnyExplicit ? 'MIXED' : 'REPOSITORY_DEFAULT',
  };
}
