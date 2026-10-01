import { DatabaseManager } from "../database/DatabaseManager";
import { EvidenceSnapshotStore } from "../analytics/EvidenceSnapshotStore";

async function main() {
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }

  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const store = new EvidenceSnapshotStore(db);
  const id = store.save({
    scopeKey:"EURUSD_H1_WFO",
    symbol:"EURUSD",
    timeframe:"H1",
    source:"WFO",
    evidence:{folds:4,oosTrades:300,stability:0.75},
    promoted:true,
    promotionReason:"valid OOS evidence",
  });
  assert(id > 0, "snapshot insert should return id");
  assert(store.latest("EURUSD_H1_WFO")?.promoted === true, "latest snapshot should round-trip");
  assert(store.latest("EURUSD_H1_WFO")?.evidence?.oosTrades === 300, "evidence payload should round-trip");
  assert(store.recent(10).length === 1, "recent snapshot should return one row");
  console.log("Result: 7 passed, 0 failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });