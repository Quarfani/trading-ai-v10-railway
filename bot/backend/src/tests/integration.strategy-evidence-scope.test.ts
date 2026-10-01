import { DatabaseManager } from "../database/DatabaseManager";
import { EvidenceSnapshotStore } from "../analytics/EvidenceSnapshotStore";
import { StrategyDefinitionStore } from "../consensus/StrategyDefinitionStore";
import { StrategyDefinition } from "../consensus/strategyDefinition";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const snapshots = new EvidenceSnapshotStore(db);
  const store = new StrategyDefinitionStore(db);

  const base: StrategyDefinition = {
    strategyId:"scope.test", name:"Scope Test", version:"1.0.0", enabled:true,
    lifecycle:"SMALL_CAPITAL",
    scope:{assetClasses:["FOREX"],symbols:["EURUSD"],timeframes:["H1"],regimes:["TRENDING"],sessions:["LONDON"]},
    requiredData:["OHLCV"], parametersVersion:"p1",
    riskProfile:{baseRiskFraction:0.01,minimumRiskReward:1.5,maximumDrawdown:0.2},
    evidence:{datasetVersion:"d1",costModelVersion:"cost-v1",sampleSize:100,outOfSampleTrades:50,outOfSampleProfitFactor:1.2,walkForwardStability:0.6,parameterSensitivity:0.6,regimeCoverage:0.6,passed:true,evaluatedAt:Date.now()},
    createdAt:Date.now(),updatedAt:Date.now(),
  };
  store.save(base);

  let missingBlocked = false;
  try { store.promote(base.strategyId,"PRODUCTION","missing snapshot"); } catch { missingBlocked = true; }
  assert(missingBlocked,"missing exact snapshot must block production promotion");

  snapshots.save({
    scopeKey:"scope.test:EURUSD:H1", strategyId:"scope.test", strategyVersion:"1.0.0",
    symbol:"EURUSD",timeframe:"H1",source:"strategy-evidence",
    evidence:base.evidence,promoted:true,promotionReason:"evidence passed",createdAt:Date.now(),
  });
  const promoted = store.promote(base.strategyId,"PRODUCTION","matching evidence");
  assert(promoted.lifecycle === "PRODUCTION","matching fresh snapshot should allow production promotion");

  const staleDef: StrategyDefinition = {...base, strategyId:"stale.test", name:"Stale Test", version:"1.0.0", lifecycle:"SMALL_CAPITAL", updatedAt:Date.now()};
  store.save(staleDef);
  snapshots.save({
    scopeKey:"stale.test:EURUSD:H1", strategyId:"stale.test", strategyVersion:"1.0.0",
    symbol:"EURUSD",timeframe:"H1",source:"strategy-evidence",evidence:staleDef.evidence,
    promoted:true,promotionReason:"old",createdAt:Date.now()-31*24*3_600_000,
  });
  let staleBlocked = false;
  try { store.promote(staleDef.strategyId,"PRODUCTION","stale"); } catch { staleBlocked = true; }
  assert(staleBlocked,"stale snapshot must block production promotion");

  const mismatchDef: StrategyDefinition = {...base, strategyId:"mismatch.test", name:"Mismatch Test", version:"2.0.0", lifecycle:"SMALL_CAPITAL", updatedAt:Date.now()};
  store.save(mismatchDef);
  snapshots.save({
    scopeKey:"mismatch.test:EURUSD:H1", strategyId:"mismatch.test", strategyVersion:"1.0.0",
    symbol:"EURUSD",timeframe:"H1",source:"strategy-evidence",evidence:mismatchDef.evidence,
    promoted:true,promotionReason:"wrong version",createdAt:Date.now(),
  });
  let mismatchBlocked = false;
  try { store.promote(mismatchDef.strategyId,"PRODUCTION","wrong version"); } catch { mismatchBlocked = true; }
  assert(mismatchBlocked,"snapshot version mismatch must block production promotion");

  console.log("Result: 8 passed, 0 failed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });