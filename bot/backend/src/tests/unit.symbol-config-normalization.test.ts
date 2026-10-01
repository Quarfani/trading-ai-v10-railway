import {
  getSymbolSpec,
  hasExplicitSpreadPolicy,
} from "../config/symbolConfig";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base = getSymbolSpec("EURUSD");
const suffixed = getSymbolSpec("EURUSD.a");

assert(base.contractSize === 100_000, "EURUSD base contract size should be preserved");
assert(suffixed.contractSize === base.contractSize, "broker-suffixed symbol should inherit canonical economics");
assert(suffixed.pip === base.pip, "broker-suffixed symbol should inherit canonical pip");
assert(hasExplicitSpreadPolicy("EURUSD.a"), "broker-suffixed configured Forex symbol should inherit spread policy");

console.log("Result: 3 passed, 0 failed");
