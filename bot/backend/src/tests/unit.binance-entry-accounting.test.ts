const { BinanceExecutor } = require("../execution/BinanceExecutor");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const executor = new BinanceExecutor({
    binance: {
      apiKey: "test",
      secret: "test",
      env: "testnet",
      futures: false,
    },
  } as any);

  (executor as any).signedGet = async (path: string, params: any) => {
    assert(path === "/api/v3/myTrades", "entry accounting must use Spot myTrades");
    assert(params.symbol === "BTCUSDT", "entry accounting must use exact symbol");
    assert(params.orderId === 1234, "entry accounting must use exact order id");
    return [
      {
        orderId: 1234,
        price: "100",
        qty: "0.3",
        commission: "0.03",
        commissionAsset: "USDT",
      },
      {
        orderId: 1234,
        price: "101",
        qty: "0.2",
        commission: "0.0005",
        commissionAsset: "BTC",
      },
    ];
  };

  const summary = await (executor as any).getSpotOrderFillSummary(
    "BTCUSDT",
    1234,
    0.5,
  );

  assert(summary !== null, "valid Spot entry fills must produce an authoritative summary");
  assert(
    Math.abs(summary.avgPrice - 100.4) < 1e-12,
    "weighted Spot entry price must be reconstructed from all fills",
  );
  assert(
    Math.abs(summary.feeQuote - 0.0805) < 1e-12,
    "base-asset and quote-asset commissions must both be converted to quote value",
  );
  assert(summary.currency === "USDT", "Spot entry fee currency must be the quote asset");

  const futures = new BinanceExecutor({
    binance: {
      apiKey: "test",
      secret: "test",
      env: "testnet",
      futures: true,
    },
  } as any);

  (futures as any).signedGet = async (path: string, params: any) => {
    assert(path === "/fapi/v1/userTrades", "Futures entry accounting must use userTrades");
    assert(params.orderId === 4321, "Futures entry accounting must use the exact order id");
    return [
      {
        orderId: 4321,
        price: "100",
        qty: "0.3",
        commission: "0.12",
        commissionAsset: "USDT",
      },
      {
        orderId: 4321,
        price: "101",
        qty: "0.2",
        commission: "0.08",
        commissionAsset: "USDT",
      },
    ];
  };

  const futuresSummary = await (futures as any).getFuturesOrderFillSummary(
    "BTCUSDT",
    4321,
    0.5,
  );
  assert(futuresSummary !== null, "valid Futures fills must produce an authoritative summary");
  assert(
    Math.abs(futuresSummary.avgPrice - 100.4) < 1e-12,
    "Futures entry price must be reconstructed from all fills",
  );
  assert(
    Math.abs(futuresSummary.commission - 0.2) < 1e-12,
    "Futures entry commission must equal the sum of authoritative fill commissions",
  );
  assert(
    futuresSummary.currency === "USDT",
    "Futures entry commission currency must be retained",
  );

  (executor as any).signedGet = async () => [
    {
      orderId: 1234,
      price: "100",
      qty: "0.5",
      commission: "1",
      commissionAsset: "BNB",
    },
  ];
  const unsupportedFee = await (executor as any).getSpotOrderFillSummary(
    "BTCUSDT",
    1234,
    0.5,
  );
  assert(
    unsupportedFee === null,
    "third-asset Spot commissions must fail closed until historical conversion is available",
  );

  console.log("Result: 5 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
