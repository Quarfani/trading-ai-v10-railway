import { Backtester } from "../backtest/Backtester";
import { ConsensusOrchestrator } from "../consensus/ConsensusOrchestrator";
import { marketRegimeDetector } from "../core/MarketRegimeDetector";
import { Candle } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const candles: Candle[] = Array.from({ length: 260 }, (_, i) => {
  const base = 1.1000 + i * 0.0001;
  const open = base;
  const close = base + 0.00005;
  return {
    time: (i + 1) * 3_600_000,
    open,
    high: close + 0.00002,
    low: open - 0.00002,
    close,
    volume: 100,
  };
});

async function main() {
  const originalRegime = marketRegimeDetector.detect;
  const originalProcess = ConsensusOrchestrator.prototype.process;

  (marketRegimeDetector as any).detect = () => ({
    regime: "TRENDING",
    confidence: 1,
    updatedAt: Date.now(),
  });

  (ConsensusOrchestrator.prototype as any).process = function (
    _symbol: string,
    history: Candle[],
  ) {
    const last = history[history.length - 1];
    return {
      outcome: "TRADE",
      signal: {
        symbol: "EURUSD",
        side: "BUY",
        price: last.close,
        sl: last.close - 0.001,
        tp: last.close + 0.002,
        confidence: 0.95,
        source: "CAUSAL_TEST",
        reason: "causal fill test",
        timestamp: last.time,
        timeframe: "H1",
      },
    };
  };

  try {
    const result = await new Backtester({
      mode: "paper",
      accountCurrency: "USD",
      accountBalance: 10_000,
      minConfidence: 0.5,
      riskPerTrade: 0.01,
    } as any).run("EURUSD", candles, 10_000, "H1", {});

    assert(result.valid, "causal backtest fixture must be valid");
    assert(result.trades.length > 0, "causal fixture must execute at least one trade");

    const first = result.trades[0];
    const executionBar = candles.reduce(
      (best, candle, index) => {
        const error = Math.abs(candle.open - first.entry);
        return error < best.error ? { index, error } : best;
      },
      { index: -1, error: Number.POSITIVE_INFINITY },
    ).index;

    assert(executionBar > 0, "trade entry must match a historical bar open");
    assert(
      Math.abs(first.entry - candles[executionBar].open) < 1e-9,
      "trade must fill at a historical bar open",
    );

    const signalBar = executionBar - 1;
    assert(
      Math.abs(first.entry - candles[signalBar].close) > 1e-9,
      "trade must not fill at the signal bar close",
    );
    assert(
      first.openedAt === candles[executionBar].time,
      "trade timestamp must reflect the execution bar",
    );

    console.log("Result: 4 passed, 0 failed");
  } finally {
    (marketRegimeDetector as any).detect = originalRegime;
    (ConsensusOrchestrator.prototype as any).process = originalProcess;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
