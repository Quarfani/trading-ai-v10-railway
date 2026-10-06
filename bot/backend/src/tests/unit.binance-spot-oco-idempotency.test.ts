const { BinanceExecutor } = require("../execution/BinanceExecutor");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeExecutor() {
  return new BinanceExecutor({
    binance: { apiKey: "test", secret: "test", env: "testnet", futures: false },
  } as any);
}

function activeOco(listClientOrderId: string, quantity = 1) {
  return {
    orderListId: 501,
    listClientOrderId,
    listStatusType: "EXEC_STARTED",
    listOrderStatus: "EXECUTING",
    orderReports: [
      {
        orderId: 601,
        clientOrderId: "above",
        type: "LIMIT_MAKER",
        side: "SELL",
        origQty: String(quantity),
        status: "NEW",
        price: "110",
      },
      {
        orderId: 602,
        clientOrderId: "below",
        type: "STOP_LOSS_LIMIT",
        side: "SELL",
        origQty: String(quantity),
        status: "NEW",
        stopPrice: "90",
        price: "89.95",
      },
    ],
  };
}

async function main() {
  const executor = makeExecutor();
  const signedPosts: any[] = [];
  const signedGets: any[] = [];

  (executor as any).signedGet = async (path: string, params: any) => {
    signedGets.push({ path, params });
    if (path === "/api/v3/openOrders") {
      return [
        { symbol: params.symbol, orderId: 601, side: "SELL", type: "LIMIT_MAKER", status: "NEW", origQty: String(params.symbol === "ETHUSDT" ? 0.5 : 1), price: "110" },
        { symbol: params.symbol, orderId: 602, side: "SELL", type: "STOP_LOSS_LIMIT", status: "NEW", origQty: String(params.symbol === "ETHUSDT" ? 0.5 : 1), stopPrice: "90", price: "89.95" },
      ];
    }
    throw new Error("no existing OCO");
  };
  (executor as any).signedPost = async (path: string, params: any) => {
    signedPosts.push({ path, params });
    return activeOco(String(params.listClientOrderId), 1);
  };

  await (executor as any).placeOCO(
    { symbol: "BTCUSDT", side: "BUY", price: 100, sl: 90, tp: 110 } as any,
    1,
    700,
    {
      pip: 0.01,
      volumeStep: 0.001,
    } as any,
    "open-operation-key",
  );

  assert(signedPosts.length === 1, "first Spot OCO should submit exactly once");
  const payload = signedPosts[0].params;
  assert(
    payload.listClientOrderId.length <= 32 &&
      payload.aboveClientOrderId.length <= 32 &&
      payload.belowClientOrderId.length <= 32,
    "all Spot OCO client IDs must fit the broker limit",
  );
  assert(
    payload.listClientOrderId ===
      (executor as any).makeOcoClientOrderId("open-operation-key", "LIST"),
    "OCO list client ID must be deterministic",
  );
  assert(
    payload.listClientOrderId !== payload.aboveClientOrderId &&
      payload.aboveClientOrderId !== payload.belowClientOrderId,
    "OCO list and leg client IDs must be distinct",
  );

  const orderMap = (executor as any).orderMap.get(700);
  assert(
    orderMap?.orderListId === 501 &&
      orderMap?.slOrderId === 602 &&
      orderMap?.tpOrderId === 601,
    "successful Spot OCO must persist authoritative list and leg identities",
  );

  const recovered = makeExecutor();
  let recoveryPostCount = 0;
  let recoveryGetCount = 0;
  (recovered as any).signedGet = async (path: string, params: any) => {
    if (path === "/api/v3/openOrders") {
      return [
        { symbol: "ETHUSDT", orderId: 601, side: "SELL", type: "LIMIT_MAKER", status: "NEW", origQty: "0.5", price: "110" },
        { symbol: "ETHUSDT", orderId: 602, side: "SELL", type: "STOP_LOSS_LIMIT", status: "NEW", origQty: "0.5", stopPrice: "90", price: "89.95" },
      ];
    }
    recoveryGetCount += 1;
    assert(path === "/api/v3/orderList", "OCO recovery must query the order-list endpoint");
    assert(
      params.origClientOrderId ===
        (recovered as any).makeOcoClientOrderId("timeout-operation-key", "LIST"),
      "OCO recovery must query the deterministic list client ID",
    );
    return activeOco(params.origClientOrderId, 0.5);
  };
  (recovered as any).signedPost = async () => {
    recoveryPostCount += 1;
    throw new Error("network timeout after broker accepted OCO");
  };

  await (recovered as any).placeOCO(
    { symbol: "ETHUSDT", side: "BUY", price: 100, sl: 90, tp: 110 } as any,
    0.5,
    701,
    { pip: 0.01, volumeStep: 0.001 } as any,
    "timeout-operation-key",
  );
  assert(recoveryGetCount >= 1, "timeout path must query for an existing OCO");
  assert(recoveryPostCount === 0, "existing OCO must be recovered without duplicate submission");
  assert(
    (recovered as any).orderMap.get(701)?.orderListId === 501,
    "recovered OCO must populate the local order identity map",
  );

  const bad = makeExecutor();
  (bad as any).signedGet = async (path: string) =>
    path === "/api/v3/openOrders" ? [] : activeOco(
      (bad as any).makeOcoClientOrderId("bad-operation-key", "LIST"),
      0.5,
    );
  const badOco = activeOco(
    (bad as any).makeOcoClientOrderId("bad-operation-key", "LIST"),
    0.5,
  );
  badOco.listStatusType = "ALL_DONE";
  let rejected = false;
  try {
    (bad as any).validateOco;
    await (bad as any).placeOCO(
      { symbol: "BTCUSDT", side: "BUY", price: 100, sl: 90, tp: 110 } as any,
      0.5,
      702,
      { pip: 0.01, volumeStep: 0.001 } as any,
      "bad-operation-key",
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "ALL_DONE Spot OCO must not be accepted as active protection");

  console.log("Result: 8 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
