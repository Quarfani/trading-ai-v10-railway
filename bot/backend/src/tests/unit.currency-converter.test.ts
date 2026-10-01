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
assert(Math.abs((resolveQuoteToAccount("EUR", "JPY", {
  EURUSD: 1.10,
  USDJPY: 150,
}) ?? 0) - 165) < 1e-12, "USD bridge EUR->JPY");
assert(Math.abs((resolveQuoteToAccount("EUR", "GBP", {
  EURGBP: 0.86,
  EURUSD: 1.10,
  GBPUSD: 1.25,
}) ?? 0) - 0.86) < 1e-12, "direct cross has priority over USD bridge");
assert(resolveQuoteToAccount("EUR", "USD", { EURUSD: 0 }) === null, "zero quote must fail closed");

console.log("Result: 9 passed, 0 failed");