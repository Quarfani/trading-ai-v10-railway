import { MarketScanner } from "../core/MarketScanner";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const scanner = new MarketScanner({} as any);
const now = Date.now();
const normalized = (scanner as any).normalizeCandles([
  { time: 1_000, open: 100, high: 105, low: 99, close: 104, volume: 10 },
  { time: 2_000, open: 100, high: 95, low: 99, close: 94, volume: 10 },
  { time: 3_000, open: 100, high: 105, low: 110, close: 104, volume: 10 },
  { time: 4_000, open: 100, high: 105, low: 99, close: 104, volume: -1 },
  { time: 5_000, open: 100, high: 105, low: 99, close: 104, volume: 10 },
  { time: now - 30_000, open: 100, high: 105, low: 99, close: 104, volume: 10 },
], 'mt5', 'M1');

assert(normalized.length === 2, "invalid OHLC/volume candles must be rejected");
assert(normalized.every((c: any) => c.quality === "good"), "valid candles retain good quality");
assert(normalized[0].time === 1_000 && normalized[1].time === 5_000, "valid candles preserve chronological order");

console.log("Result: 4 passed, 0 failed");
