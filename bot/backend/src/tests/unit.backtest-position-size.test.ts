import { calculateBacktestPositionSize } from "../backtest/Backtester";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const brokerContractVolume = calculateBacktestPositionSize(
  10_000, 0.01, 1.1000, 1.0990,
  1, 0.03, 0.09, 0.03, 1,
);
assert(
  brokerContractVolume === 0.09,
  "backtest sizing must honor broker max/step economics",
);

const standardVolume = calculateBacktestPositionSize(
  10_000, 0.01, 1.1000, 1.0950,
  100_000, 0.01, 100, 0.01, 1,
);
assert(
  standardVolume === 0.2,
  "standard Forex contract sizing should preserve risk calculation",
);

const invalidConversion = calculateBacktestPositionSize(
  10_000, 0.01, 1.1000, 1.0950,
  100_000, 0.01, 100, 0.01, 0,
);
assert(
  invalidConversion === 0,
  "missing account-currency conversion must fail closed",
);

console.log("Result: 3 passed, 0 failed");
