import { MonteCarloSimulator } from "../optimization/MonteCarloSimulator";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const trades = [
  { profit: 120 },
  { profit: -80 },
  { profit: 60 },
  { profit: -30 },
  { profit: 200 },
  { profit: -120 },
  { profit: 90 },
  { profit: -50 },
  { profit: 40 },
  { profit: -20 },
];

const mc = new MonteCarloSimulator();
const a = mc.run(trades, 10_000, 500, 100, 0x12345678);
const b = mc.run(trades, 10_000, 500, 100, 0x12345678);
const c = mc.run(trades, 10_000, 500, 100, 0x87654321);

assert(a.p5 === b.p5, "same seed must reproduce p5");
assert(a.p50 === b.p50, "same seed must reproduce p50");
assert(a.maxDD_p95 === b.maxDD_p95, "same seed must reproduce maxDD_p95");
assert(JSON.stringify(a.samplePaths) === JSON.stringify(b.samplePaths), "same seed must reproduce sample paths");
assert(Number.isFinite(a.expectedReturn), "expected return must be finite");
assert(
  Math.abs(a.expectedReturn - b.expectedReturn) < 1e-12,
  "same seed must reproduce mean expected return",
);
assert(
  a.samplePaths.length === 20 && c.samplePaths.length === 20,
  "Monte Carlo should retain exactly 20 visualization paths",
);

console.log("Result: 7 passed, 0 failed");
