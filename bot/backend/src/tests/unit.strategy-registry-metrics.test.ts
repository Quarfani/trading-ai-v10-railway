import { DatabaseManager } from "../database/DatabaseManager";
import { StrategyRegistry } from "../consensus/StrategyRegistry";
import { IStrategy } from "../consensus/types";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const noopStrategy: IStrategy = {
  name: "METRIC_TEST",
  enabled: true,
  generateSignal: () => null as any,
};

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  const registry = new StrategyRegistry(
    db,
    { rolling_window_size: 30 },
    undefined,
    10_000,
  );
  registry.register(noopStrategy);

  const base = Date.parse("2026-01-01T12:00:00Z");
  const profits = [
    -1_000,
    500,
    700,
    -200,
    300,
  ];

  profits.forEach((profit, i) => {
    registry.recordTrade(
      "METRIC_TEST",
      profit,
      1,
      1,
    );
    const metrics = registry.getMetrics("METRIC_TEST")!;
    if (i === 0) {
      assert(metrics.max_drawdown > 0.09, "initial loss must produce a real drawdown from starting equity");
      assert(metrics.max_drawdown < 0.11, "initial 10% loss should be approximately 10% drawdown");
    }
  });

  const metrics = registry.getMetrics("METRIC_TEST")!;
  assert(Number.isFinite(metrics.sharpe_ratio), "daily Sharpe must be finite");
  assert(metrics.sharpe_ratio !== 0, "multiple observations across days should produce a non-zero Sharpe");

  console.log("Result: 4 passed, 0 failed");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
