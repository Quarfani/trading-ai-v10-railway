import { DatabaseManager } from "../database/DatabaseManager";
import { DrawdownRecoveryMode } from "../risk/DrawdownRecoveryMode";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const telegram = { sendMessage: async () => {} } as any;

  const accountA = new DrawdownRecoveryMode(db, telegram, 10_000, "account-A");
  const accountB = new DrawdownRecoveryMode(db, telegram, 10_000, "account-B");

  accountA.evaluate(11_000);
  const aRecovered = accountA.evaluate(10_500);
  const bFresh = accountB.evaluate(10_000);

  assert(aRecovered.peakEquity === 11_000, "account A must retain its own persisted peak");
  assert(bFresh.peakEquity === 10_000, "account B must not inherit account A peak");

  console.log("Result: 3 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
