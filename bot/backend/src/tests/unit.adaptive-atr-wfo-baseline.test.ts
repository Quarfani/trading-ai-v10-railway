import { AdaptiveATRManager } from "../optimization/AdaptiveATRManager";
import { DatabaseManager } from "../database/DatabaseManager";

async function main() {
  function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
  const db = new DatabaseManager(":memory:");
  await db.initialize();
  const manager = new AdaptiveATRManager(db);
  const candles = Array.from({ length: 120 }, (_, i) => ({
    time: Date.now() - (120 - i) * 3_600_000, open:100, high:101, low:99, close:100.5, volume:100,
  }));

  db.setSetting("wfo_params_EURUSD_H1", JSON.stringify({ atrMult: 2.2, tpRatio: 3.1, updatedAt: Date.now(), wfoValid: true }));
  const withWfo = manager.getParams("EURUSD", candles, "H1");
  assert(withWfo.reason.includes("WFO baseline applied"), "valid WFO baseline must be applied");
  assert(withWfo.atrMult >= 0.8 && withWfo.atrMult <= 3.5, "adaptive bound must remain hard");

  db.setSetting("wfo_params_EURUSD_M5", JSON.stringify({ atrMult: 9, tpRatio: 9, updatedAt: Date.now() - 31 * 24 * 3_600_000, wfoValid: true }));
  const expired = manager.getParams("EURUSD", candles, "M5");
  assert(!expired.reason.includes("WFO baseline applied"), "expired WFO baseline must not be used");

  db.setSetting("wfo_params_EURUSD_M15", JSON.stringify({ atrMult: 2.0, tpRatio: 2.5, updatedAt: Date.now(), wfoValid: false }));
  const invalid = manager.getParams("EURUSD", candles, "M15");
  assert(!invalid.reason.includes("WFO baseline applied"), "invalid WFO baseline must not be used");

  for (const key of [
    "SPEC_EURUSD_H1_ATR_MULT","SPEC_EURUSD_H1_TP_RATIO",
    "SPEC_EURUSD_M5_ATR_MULT","SPEC_EURUSD_M5_TP_RATIO",
    "SPEC_EURUSD_M15_ATR_MULT","SPEC_EURUSD_M15_TP_RATIO",
  ]) delete process.env[key];

  console.log("Result: 8 passed, 0 failed");
}
main().catch(error => { console.error(error); process.exitCode = 1; });