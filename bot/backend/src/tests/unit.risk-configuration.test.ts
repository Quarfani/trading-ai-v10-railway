import { validateRiskConfiguration } from '../risk/RiskManager';

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'paper',
    accountBalance: 10_000,
    accountCurrency: 'USD',
    riskPerTrade: 0.01,
    maxOpenTrades: 5,
    minConfidence: 0.55,
    maxDailyLoss: 0.02,
    dailyProfitTarget: 0.03,
    consecutiveLossLimit: 3,
    cooldownMinutes: 60,
    minRR: 1.5,
    maxWeeklyLoss: 0.05,
    maxDrawdown: 0.10,
    maxPortfolioHeat: 0.06,
    maxExposure: 1,
    maxLeverage: 3,
    maxSlippagePct: 0.005,
    maxSlippagePips: 3,
    ...overrides,
  } as any;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  validateRiskConfiguration(baseConfig()).length === 0,
  'valid risk configuration must pass',
);

assert(
  validateRiskConfiguration(baseConfig({ maxSlippagePct: 0 })).length === 0,
  'zero maxSlippagePct is a valid strict gate',
);

assert(
  validateRiskConfiguration(baseConfig({ maxSlippagePips: 0 })).length === 0,
  'zero maxSlippagePips is a valid strict gate',
);

assert(
  validateRiskConfiguration(baseConfig({ dailyProfitTarget: 0 })).length === 0,
  'zero dailyProfitTarget is a valid disabled setting',
);

assert(
  validateRiskConfiguration(baseConfig({ minRR: Number.NaN }))
    .some(r => r.includes('minRR')),
  'NaN minRR must be rejected',
);

assert(
  validateRiskConfiguration(baseConfig({ maxDrawdown: Number.NaN }))
    .some(r => r.includes('maxDrawdown')),
  'NaN maxDrawdown must be rejected',
);

assert(
  validateRiskConfiguration(baseConfig({ maxSlippagePct: Number.NaN }))
    .some(r => r.includes('maxSlippagePct')),
  'NaN maxSlippagePct must be rejected',
);

assert(
  validateRiskConfiguration(baseConfig({ riskPerTrade: 0.0201 }))
    .some(r => r.includes('2%')),
  'riskPerTrade above 2% hard cap must be rejected',
);

assert(
  validateRiskConfiguration(baseConfig({ maxOpenTrades: 2.5 }))
    .some(r => r.includes('maxOpenTrades')),
  'non-integer maxOpenTrades must be rejected',
);

console.log('Result: 11 passed, 0 failed');
