import { PaperTrader } from "../integration/PaperTrader";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const key = "COST_BTCUSDT_HOLDING_RATE_DAY";
const previous = process.env[key];
process.env[key] = "0.001";

try {
  const trader = new PaperTrader(10_000);
  const signal: any = {
    symbol: "BTCUSDT", side: "BUY", price: 100, confidence: 0.9,
    sl: 90, tp: 120, source: "TEST", reason: "holding",
    timestamp: Date.now(), timeframe: "H1",
  };

  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const trade = trader.placeOrder(signal, 2, "H1", 0.90);
    const closeAt = trade.openedAt + 2 * 24 * 3_600_000;
    const result = trader.closeTrade(trade.ticket!, 110, "MANUAL", closeAt, 0.95);
    assert(result.ok, "paper trade should close");
    assert(Number.isFinite(result.profit), "holding-cost-adjusted profit must be finite");

    const withoutHolding = new PaperTrader(10_000);
    const t2 = withoutHolding.placeOrder(signal, 2, "H1", 0.90);
    const previousRate = process.env[key];
    process.env[key] = "0";
    const r2 = withoutHolding.closeTrade(t2.ticket!, 110, "MANUAL", t2.openedAt + 2 * 24 * 3_600_000, 0.95);
    if (previousRate === undefined) delete process.env[key];
    else process.env[key] = previousRate;
    assert(r2.ok, "baseline paper trade should close");
    assert(result.profit < r2.profit, "holding cost must reduce paper profit");

    const eurAccountTrader = new PaperTrader(10_000, "EUR");
    let restoreBlocked = false;
    try {
      eurAccountTrader.restoreState([{
        ticket: 500,
        symbol: "EURUSD",
        side: "BUY",
        volume: 0.01,
        entry: 1.1,
        sl: 1.09,
        tp: 1.12,
        status: "open",
        openedAt: Date.now(),
        source: "RESTORE_TEST",
        timeframe: "H1",
      } as any], []);
    } catch {
      restoreBlocked = true;
    }
    assert(
      restoreBlocked,
      "restoring a non-USD paper position without entry FX conversion must fail closed",
    );
  } finally {
    Math.random = originalRandom;
  }
  console.log("Result: 4 passed, 0 failed");
} finally {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}
