import { SlippageGuard } from "../execution/SlippageGuard";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const guard = new SlippageGuard();

const signal: any = {
  symbol: "EURUSD",
  side: "BUY",
  price: 1.1000,
  sl: 1.0900,
  tp: 1.1200,
  source: "TEST",
  reason: "slippage",
  confidence: 0.9,
  timestamp: Date.now(),
};

const within = guard.check(signal, { entry: 1.1002 } as any, 0.0005);
assert(within.ok, "fill within configured percentage should pass");
assert(within.slippagePct > 0, "slippage percentage should be measurable");

const blocked = guard.check(signal, { entry: 1.1010 } as any, 0.0005);
assert(!blocked.ok, "fill outside configured percentage should block");

const invalid = guard.check(signal, { entry: Number.NaN } as any, 0.0005);
assert(!invalid.ok, "non-finite fill must fail closed");

const invalidLimit = guard.check(signal, { entry: 1.1001 } as any, Number.NaN);
assert(!invalidLimit.ok, "non-finite slippage limit must fail closed");

console.log("Result: 8 passed, 0 failed");
