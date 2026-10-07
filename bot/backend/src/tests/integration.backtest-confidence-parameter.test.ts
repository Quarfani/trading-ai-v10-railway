import { Backtester } from "../backtest/Backtester";
import { ConsensusOrchestrator } from "../consensus/ConsensusOrchestrator";
import { marketRegimeDetector } from "../core/MarketRegimeDetector";
import { Candle } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const candles: Candle[] = Array.from({ length: 260 }, (_, i) => {
  const base = 1.1000 + i * 0.0001;
  return {
    time: Date.now() - (260 - i) * 3_600_000,
    open: base,
    high: base + 0.001,
    low: base - 0.001,
    close: base + 0.0002,
    volume: 100,
  };
});

async function run(minConfidence: number) {
  return new Backtester({
    mode: "paper",
    accountCurrency: "USD",
    accountBalance: 10_000,
    riskPerTrade: 0.01,
    minConfidence,
  } as any).run("EURUSD", candles, 10_000, "H1", {});
}

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
        sl: last.close - 0.002,
        tp: last.close + 0.004,
        confidence: 0.8,
        source: "CONFIDENCE_TEST",
        reason: "confidence parameter test",
        timestamp: last.time,
        timeframe: "H1",
      },
    };
  };

  try {
    const permissive = await run(0.7);
    const strict = await run(0.9);

    assert(permissive.valid && strict.valid, "confidence fixture backtests must be valid");
    assert(permissive.totalTrades > 0, "lower confidence threshold must allow the fixture signals");
    assert(strict.totalTrades === 0, "higher confidence threshold must block the fixture signals");

    console.log("Result: 3 passed, 0 failed");
  } finally {
    (marketRegimeDetector as any).detect = originalRegime;
    (ConsensusOrchestrator.prototype as any).process = originalProcess;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
