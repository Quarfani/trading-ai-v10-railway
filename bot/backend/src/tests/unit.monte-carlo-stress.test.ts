import { runMonteCarloStress } from "../optimization/MonteCarloStress";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const trades = Array.from({ length: 30 }, (_, i) => ({
  profit: i % 3 === 0 ? 150 : -60,
  cost: 5,
  notional: 10_000,
}));

const base = runMonteCarloStress(trades, 10_000, {
  simulations: 500,
  futureTrades: 100,
  seed: 12345,
});
const stressed = runMonteCarloStress(trades, 10_000, {
  simulations: 500,
  futureTrades: 100,
  extraCostPerTrade: 20,
  slippageBps: 5,
  seed: 12345,
});

assert(base.simulations === 500, "simulation count should be configurable");
assert(base.futureTrades === 100, "future trade horizon should be configurable");
assert(base.p95FinalBalance >= base.p5FinalBalance, "final balance percentiles must be ordered");
assert(base.maxDDP95 >= base.maxDDP50, "drawdown percentiles must be ordered");
assert(base.recoveryTradesP50 == null || base.recoveryTradesP50 >= 0, "recovery time must be non-negative");
assert(stressed.p50FinalBalance <= base.p50FinalBalance, "added friction should not improve median balance");
assert(stressed.probabilityLoss >= base.probabilityLoss, "added friction should not reduce loss probability");
assert(stressed.unrecoveredRate >= 0 && stressed.unrecoveredRate <= 1, "unrecovered rate must be bounded");

console.log("Result: 9 passed, 0 failed");