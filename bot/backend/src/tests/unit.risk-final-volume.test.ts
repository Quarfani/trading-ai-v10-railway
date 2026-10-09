import { RiskManager } from '../risk/RiskManager';
import { PortfolioHeat } from '../risk/PortfolioHeat';
import { Trade } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function gate(config: any): any {
  const instance = Object.create(RiskManager.prototype);
  instance.mode = config.mode;
  instance.config = config;
  instance.heat = new PortfolioHeat(config);
  return instance;
}

const openTrade: Trade = {
  symbol: 'EURUSD',
  volume: 0.5,
  entry: 1,
  sl: 0.99,
  tp: 1.02,
  side: 'BUY',
  status: 'open',
  openedAt: Date.now(),
  source: 'TEST',
  timeframe: 'H1',
};

const signal = {
  symbol: 'EURUSD',
  side: 'BUY' as const,
  sl: 0.99,
  timeframe: 'H1' as const,
};
const prices = { EURUSD: 1 };
const equity = 100_000;

function main(): void {
  let passed = 0;
  const check = (condition: unknown, message: string) => {
    assert(condition, message);
    passed += 1;
  };

  const exposureGate = gate({
    mode: 'paper',
    accountCurrency: 'USD',
    maxExposure: 1.25,
    maxLeverage: 3,
    maxPortfolioHeat: 0.06,
  });
  const permitted = exposureGate.validateFinalVolume(
    [openTrade], signal, 0.7, 1, equity, prices,
  );
  check(permitted.passed, 'final volume within exposure and heat caps should pass');

  const excessiveExposure = exposureGate.validateFinalVolume(
    [openTrade], signal, 0.8, 1, equity, prices,
  );
  check(!excessiveExposure.passed && excessiveExposure.blockedBy === 'final_exposure_leverage',
    'final volume exceeding gross exposure must be blocked');

  const heatGate = gate({
    mode: 'paper',
    accountCurrency: 'USD',
    maxExposure: 3,
    maxLeverage: 4,
    maxPortfolioHeat: 0.02,
  });
  const excessiveHeat = heatGate.validateFinalVolume(
    [openTrade], signal, 1.6, 1, equity, prices,
  );
  check(!excessiveHeat.passed && excessiveHeat.blockedBy === 'final_portfolio_heat',
    'final volume exceeding portfolio heat must be blocked even when leverage is acceptable');

  const invalidFinalVolume = exposureGate.validateFinalVolume(
    [openTrade], signal, Number.NaN, 1, equity, prices,
  );
  check(!invalidFinalVolume.passed && invalidFinalVolume.blockedBy === 'final_volume_invalid',
    'invalid final volume must fail closed');

  const invalidStop = exposureGate.validateFinalVolume(
    [openTrade], { ...signal, sl: 1.01 }, 0.1, 1, equity, prices,
  );
  check(!invalidStop.passed && invalidStop.blockedBy === 'final_volume_invalid',
    'final stop on the wrong side of the execution price must fail closed');

  console.log(`Result: ${passed} passed, 0 failed`);
}

main();
