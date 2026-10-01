import { resolveQuoteToAccount } from "../market/CurrencyConverter";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(resolveQuoteToAccount("GBP", "USD", { GBPUSD: 1.25 }) === 1.25, "direct GBPUSD conversion");
assert(Math.abs((resolveQuoteToAccount("JPY", "USD", { USDJPY: 150 }) ?? 0) - 1 / 150) < 1e-12, "inverse USDJPY conversion");
assert(Math.abs((resolveQuoteToAccount("GBP", "EUR", { GBPUSD: 1.25, EURUSD: 1.25 }) ?? 0) - 1) < 1e-12, "USD bridge GBP->EUR");
assert(resolveQuoteToAccount("GBP", "EUR", { GBPUSD: 1.25 }) === null, "missing account leg must fail closed");
assert(resolveQuoteToAccount("USDT", "USD", {}) === 1, "USD stablecoin identity for USD account");
assert(resolveQuoteToAccount("GBP", "GBP", {}) === 1, "same currency identity");

console.log("Result: 6 passed, 0 failed");