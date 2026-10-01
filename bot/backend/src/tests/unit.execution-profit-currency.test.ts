import { DatabaseManager } from "../database/DatabaseManager";
import { ExecutionGateway } from "../execution/ExecutionGateway";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  const gateway = new ExecutionGateway(
    {
      mode: "binance",
      accountBalance: 10_000,
      accountCurrency: "EUR",
      riskPerTrade: 0.01,
      binance: {
        apiKey: "",
        secret: "",
        env: "testnet",
        futures: true,
      },
    } as any,
    db,
    {
      getRate: async (currency: string) => {
        assert(currency === "USDT", "profit conversion should request the broker PnL currency");
        return 0.92;
      },
    } as any,
  );

  const converted = await (gateway as any).convertBrokerProfitToAccount(100, "USDT");
  assert(Math.abs(converted - 92) < 1e-12, "USDT realized PnL must convert into configured EUR account currency");

  const identity = await (gateway as any).convertBrokerProfitToAccount(100, "EUR");
  assert(identity === 100, "PnL already in account currency must not be converted");

  let blocked = false;
  const noRateGateway = new ExecutionGateway(
    { mode:"binance", accountBalance:10_000, accountCurrency:"EUR", riskPerTrade:0.01, binance:{apiKey:"",secret:"",env:"testnet",futures:true} } as any,
    db,
    undefined,
  );
  try {
    await (noRateGateway as any).convertBrokerProfitToAccount(100, "USDT");
  } catch {
    blocked = true;
  }
  assert(blocked, "missing broker-profit FX conversion must fail closed");

  console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
