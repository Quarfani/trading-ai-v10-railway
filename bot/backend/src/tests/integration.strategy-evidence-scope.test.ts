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

  // Monte Carlo gate is opt-in and must fail closed when enabled.
  const mcPolicy = {
    minSampleSize: 100,
    minOutOfSampleTrades: 30,
    minOutOfSampleProfitFactor: 1.05,
    minWalkForwardStability: 0.5,
    minParameterSensitivity: 0.5,
    minRegimeCoverage: 0.5,
    maxAgeMs: 30 * 24 * 3_600_000,
    requireMonteCarlo: true,
    maxMonteCarloDD95: 0.30,
    maxMonteCarloRuinProbability: 0.05,
    maxMonteCarloUnrecoveredRate: 0.25,
  };
  const mcStore = new StrategyDefinitionStore(db, mcPolicy);
  const mcBase: StrategyDefinition = {
    ...base,
    strategyId: "mc.test",
    name: "MC Test",
    lifecycle: "SMALL_CAPITAL",
    evidence: {
      ...base.evidence!,
      monteCarloStress: {
        simulations: 500,
        futureTrades: 100,
        p5FinalBalance: 9_000,
        p50FinalBalance: 10_500,
        maxDDP95: 0.20,
        probabilityLoss: 0.08,
        probabilityDD20: 0.05,
        probabilityRuin: 0.01,
        unrecoveredRate: 0.10,
        recoveryTradesP95: 25,
      },
    },
  };
  mcStore.save(mcBase);
  snapshots.save({
    scopeKey:"mc.test:EURUSD:H1", strategyId:"mc.test", strategyVersion:"1.0.0",
    symbol:"EURUSD",timeframe:"H1",source:"strategy-evidence",
    evidence:mcBase.evidence,promoted:true,promotionReason:"mc passed",createdAt:Date.now(),
  });
  const mcPromoted = mcStore.promote("mc.test","PRODUCTION","mc passed");
  assert(mcPromoted.lifecycle === "PRODUCTION","passing Monte Carlo snapshot should allow production");

  const mcMissing: StrategyDefinition = {
    ...mcBase,
    strategyId: "mc.missing",
    name: "MC Missing",
    evidence: { ...base.evidence! },
  };
  mcStore.save(mcMissing);
  snapshots.save({
    scopeKey:"mc.missing:EURUSD:H1", strategyId:"mc.missing", strategyVersion:"1.0.0",
    symbol:"EURUSD",timeframe:"H1",source:"strategy-evidence",
    evidence:mcMissing.evidence,promoted:true,promotionReason:"missing mc",createdAt:Date.now(),
  });
  let mcMissingBlocked = false;
  try { mcStore.promote("mc.missing","PRODUCTION","missing mc"); } catch { mcMissingBlocked = true; }
  assert(mcMissingBlocked,"Monte Carlo policy must block snapshots without MC evidence");

  const mcBad: StrategyDefinition = {
    ...mcBase,
    strategyId: "mc.bad",
    name: "MC Bad",
    evidence: {
      ...mcBase.evidence!,
      monteCarloStress: {
        ...mcBase.evidence!.monteCarloStress!,
        maxDDP95: 0.40,
      },
    },
  };
  mcStore.save(mcBad);
  snapshots.save({
    scopeKey:"mc.bad:EURUSD:H1", strategyId:"mc.bad", strategyVersion:"1.0.0",
    symbol:"EURUSD",timeframe:"H1",source:"strategy-evidence",
    evidence:mcBad.evidence,promoted:true,promotionReason:"bad mc",createdAt:Date.now(),
  });
  let mcBadBlocked = false;
  try { mcStore.promote("mc.bad","PRODUCTION","bad mc"); } catch { mcBadBlocked = true; }
  assert(mcBadBlocked,"Monte Carlo policy must block excessive P95 drawdown");

  console.log("Result: 11 passed, 0 failed");
}

main().catch(error => { console.error(error); process.exitCode = 1; });