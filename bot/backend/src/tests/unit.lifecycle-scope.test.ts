import { DatabaseManager } from "../database/DatabaseManager";
import { StrategyDefinitionStore } from "../consensus/StrategyDefinitionStore";
import { ConsensusOrchestrator } from "../consensus/ConsensusOrchestrator";
import { clearBrokerContracts, registerBrokerContract } from "../market/MarketCatalog";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();

  clearBrokerContracts();
  registerBrokerContract({
    symbol: "EURUSD.a",
    baseAsset: "EUR",
    quoteCurrency: "USD",
    assetClass: "FOREX",
    contractType: "CFD",
    venue: "MT5",
    contractSize: 100000,
    priceIncrement: 0.00001,
    minVolume: 0.01,
    maxVolume: 100,
    volumeStep: 0.01,
    marginModel: "BROKER_DEFINED",
    source: "lifecycle-scope-test",
    observedAt: Date.now(),
    verified: true,
  });

  const store = new StrategyDefinitionStore(db);
  store.save({
    strategyId: "scope-trend",
    name: "TREND",
    version: "1.0.0",
    enabled: true,
    lifecycle: "PRODUCTION",
    scope: {
      assetClasses: ["FOREX"],
      symbols: ["EURUSD"],
      timeframes: ["H1"],
      regimes: ["TRENDING"],
      sessions: [],
    },
    requiredData: ["OHLCV"],
    parametersVersion: "p1",
    riskProfile: {
      baseRiskFraction: 0.01,
      minimumRiskReward: 1.5,
      maximumDrawdown: 0.2,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);

  const orchestrator = new ConsensusOrchestrator(db);

  const allowed = orchestrator.isExecutionLifecycleEligible(
    "TREND",
    "mt5",
    "EURUSD",
    "H1",
    "TRENDING",
  );
  assert(allowed.allowed, "matching strategy scope must be eligible");

  const wrongTf = orchestrator.isExecutionLifecycleEligible(
    "TREND",
    "mt5",
    "EURUSD",
    "H4",
    "TRENDING",
  );
  assert(!wrongTf.allowed, "strategy must be blocked outside its timeframe scope");

  const wrongRegime = orchestrator.isExecutionLifecycleEligible(
    "TREND",
    "mt5",
    "EURUSD",
    "H1",
    "RANGING",
  );
  assert(!wrongRegime.allowed, "strategy must be blocked outside its regime scope");

  const wrongSymbol = orchestrator.isExecutionLifecycleEligible(
    "TREND",
    "mt5",
    "GBPUSD.a",
    "H1",
    "TRENDING",
  );
  assert(!wrongSymbol.allowed, "strategy must be blocked outside its symbol scope");

  const brokerSuffix = orchestrator.isExecutionLifecycleEligible(
    "TREND",
    "mt5",
    "EURUSD.a",
    "H1",
    "TRENDING",
  );
  assert(brokerSuffix.allowed, "broker suffix should normalize to the canonical symbol");

  clearBrokerContracts();
  console.log("Result: 5 passed, 0 failed");
}

main().catch(error => {
  clearBrokerContracts();
  console.error(error);
  process.exitCode = 1;
});
