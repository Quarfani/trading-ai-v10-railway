/**
 * SHARED ECONOMIC COST MODEL
 *
 * Cost accounting used by research/backtest and paper execution.
 * Broker-specific live values must be supplied explicitly before production.
 */
export const COST_MODEL_VERSION = 'cost-v2';

export interface CostProfile {
  version: string;
  commission: {
    fixedRoundTripPerVolumeAccount: number;
    notionalRatePerSide: number;
  };
  spreadPricePerSide: number;
  marketImpactBpsPerSide: number;
  holdingRatePerDay: number;
  source: 'REPOSITORY_DEFAULT' | 'ENV_EXPLICIT' | 'MIXED';
}

export interface CostInput {
  entryPrice: number;
  exitPrice: number;
  volume: number;
  contractSize: number;
  quoteToAccount: number;
  /** Optional timestamp-specific conversion rates for research. */
  entryQuoteToAccount?: number;
  exitQuoteToAccount?: number;
  holdingDays?: number;
}

export interface SideCostInput {
  price: number;
  volume: number;
  contractSize: number;
  quoteToAccount: number;
}

export interface CostBreakdown {
  entryCommission: number;
  exitCommission: number;
  commission: number;
  spread: number;
  marketImpact: number;
  holding: number;
  total: number;
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[CostModel] ${name} must be finite and > 0`);
  }
  return value;
}

function nonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`[CostModel] ${name} must be finite and >= 0`);
  }
  return value;
}

function notionalAccount(input: SideCostInput): number {
  return (
    positive('price', input.price) *
    positive('volume', input.volume) *
    positive('contractSize', input.contractSize) *
    positive('quoteToAccount', input.quoteToAccount)
  );
}

export function estimateEntryCosts(
  input: SideCostInput,
  profile: CostProfile,
): number {
  const notional = notionalAccount(input);
  const fixed = nonNegative(
    'fixedRoundTripPerVolumeAccount',
    profile.commission.fixedRoundTripPerVolumeAccount,
  ) * input.volume / 2;
  const commission =
    fixed +
    notional *
      nonNegative(
        'notionalRatePerSide',
        profile.commission.notionalRatePerSide,
      );
  const spread =
    nonNegative('spreadPricePerSide', profile.spreadPricePerSide) *
    input.volume *
    input.contractSize *
    input.quoteToAccount;
  const impact =
    notional *
    (nonNegative('marketImpactBpsPerSide', profile.marketImpactBpsPerSide) / 10_000);
  return commission + spread + impact;
}

export function estimateExitCosts(
  input: SideCostInput,
  profile: CostProfile,
): number {
  return estimateEntryCosts(input, profile);
}

export function estimateHoldingCost(
  input: CostInput,
  profile: CostProfile,
): number {
  const holdingDays = nonNegative(
    'holdingDays',
    input.holdingDays ?? 0,
  );
  if (holdingDays === 0) return 0;

  const entryRate = input.entryQuoteToAccount ?? input.quoteToAccount;
  const exitRate = input.exitQuoteToAccount ?? input.quoteToAccount;
  const entryNotional = notionalAccount({
    price: input.entryPrice,
    volume: input.volume,
    contractSize: input.contractSize,
    quoteToAccount: entryRate,
  });
  const exitNotional = notionalAccount({
    price: input.exitPrice,
    volume: input.volume,
    contractSize: input.contractSize,
    quoteToAccount: exitRate,
  });

  return (
    ((entryNotional + exitNotional) / 2) *
    nonNegative('holdingRatePerDay', profile.holdingRatePerDay) *
    holdingDays
  );
}

export function estimateCosts(
  input: CostInput,
  profile: CostProfile,
): CostBreakdown {
  const entryRate = input.entryQuoteToAccount ?? input.quoteToAccount;
  const exitRate = input.exitQuoteToAccount ?? input.quoteToAccount;

  const entryNotional = notionalAccount({
    price: input.entryPrice,
    volume: input.volume,
    contractSize: input.contractSize,
    quoteToAccount: entryRate,
  });
  const exitNotional = notionalAccount({
    price: input.exitPrice,
    volume: input.volume,
    contractSize: input.contractSize,
    quoteToAccount: exitRate,
  });

  const fixedHalf =
    nonNegative(
      'fixedRoundTripPerVolumeAccount',
      profile.commission.fixedRoundTripPerVolumeAccount,
    ) * input.volume / 2;
  const rate = nonNegative(
    'notionalRatePerSide',
    profile.commission.notionalRatePerSide,
  );

  const entryCommission = fixedHalf + entryNotional * rate;
  const exitCommission = fixedHalf + exitNotional * rate;
  const commission = entryCommission + exitCommission;

  const spreadPerSide = nonNegative(
    'spreadPricePerSide',
    profile.spreadPricePerSide,
  );
  const spread =
    spreadPerSide * input.volume * input.contractSize * entryRate +
    spreadPerSide * input.volume * input.contractSize * exitRate;

  const impact =
    (entryNotional + exitNotional) *
    (nonNegative('marketImpactBpsPerSide', profile.marketImpactBpsPerSide) / 10_000);

  const holding = estimateHoldingCost(input, profile);

  return {
    entryCommission,
    exitCommission,
    commission,
    spread,
    marketImpact: impact,
    holding,
    total: commission + spread + impact + holding,
  };
}

export function calculateGrossPnlAccount(input: {
  entryPrice: number;
  exitPrice: number;
  volume: number;
  contractSize: number;
  quoteToAccount: number;
  side: 'BUY' | 'SELL';
}): number {
  return (
    (positive('exitPrice', input.exitPrice) -
      positive('entryPrice', input.entryPrice)) *
    (input.side === 'BUY' ? 1 : -1) *
    positive('volume', input.volume) *
    positive('contractSize', input.contractSize) *
    positive('quoteToAccount', input.quoteToAccount)
  );
}
