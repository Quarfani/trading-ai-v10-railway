import axios from "axios";
import { MarketScanner } from "../core/MarketScanner";
import { SystemConfig } from "../types/trading.types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const config = {
    mode: "mt5",
    dataSource: "mt5",
    symbols: ["EURUSD.a"],
    accountCurrency: "USD",
    mt5: {
      login: 1,
      password: "x",
      server: "x",
      bridgeUrl: "http://mt5.test",
      bridgeApiKey: "secret",
    },
  } as SystemConfig;

  const originalGet = axios.get;
  const calls: Array<{url: string; params: any}> = [];

  (axios as any).get = async (url: string, options: any) => {
    calls.push({ url, params: options?.params });
    assert(url === "http://mt5.test/candles", "MT5 scanner must call /candles");
    return {
      data: {
        ok: true,
        symbol: "EURUSD.a",
        timeframe: "H1",
        candles: [
          { time: 1_000_000, open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: 10 },
          { time: 2_000_000, open: 1.105, high: 1.115, low: 1.10, close: 1.11, volume: 12 },
        ],
      },
    };
  };

  try {
    const scanner = new MarketScanner(config);
    const candles = await scanner.fetchCandles("EURUSD.a", "H1", 250);

    assert(candles.length === 2, "scanner must return bridge candles");
    assert(candles[0].source === "mt5", "scanner must tag MT5 candles");
    assert(candles[1].close === 1.11, "scanner must preserve close price");
    assert(calls.length === 1, "scanner should make one bridge request");
    assert(calls[0].params.symbol === "EURUSD.a", "scanner must preserve exact broker symbol");
    assert(calls[0].params.timeframe === "H1", "scanner must send timeframe");
    assert(calls[0].params.count === 250, "scanner must send requested count");

    console.log("Result: 6 passed, 0 failed");
  } finally {
    (axios as any).get = originalGet;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
