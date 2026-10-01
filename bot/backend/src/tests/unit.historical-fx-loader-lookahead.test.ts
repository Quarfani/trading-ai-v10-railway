import { loadHistoricalCurrencySeries } from "../market/HistoricalCurrencySeriesLoader";
import { resolveHistoricalQuoteToAccount } from "../market/HistoricalCurrencySeries";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const day = 24 * 60 * 60_000;
  const open = 1_000_000;

  const series = await loadHistoricalCurrencySeries(
    "GBP",
    "USD",
    async (pair) => {
      assert(pair === "GBPUSD", "loader must prefer direct GBPUSD history");
      return [
        { time: open, close: 1.25 },
        { time: open + day, close: 1.30 },
      ];
    },
    2,
  );

  assert(series.GBPUSD?.[0].time === open + day - 1,
    "historical FX observation must be anchored at the D1 candle close");

  const beforeClose = resolveHistoricalQuoteToAccount(
    "GBP",
    "USD",
    open + day - 2,
    series,
  );
  assert(beforeClose === null, "current D1 close must not be visible before the bar closes");

  const afterClose = resolveHistoricalQuoteToAccount(
    "GBP",
    "USD",
    open + day,
    series,
  );
  assert(afterClose === 1.25, "the latest completed D1 close must be used after close");

  console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
