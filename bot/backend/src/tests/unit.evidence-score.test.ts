import { calculateEvidenceScore } from "../research/EvidenceScore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const base = {
  sampleSize: 400,
  outOfSampleTrades: 300,
  walkForwardStability: 0.8,
  regimeCoverage: 0.8,
  parameterSensitivity: 0.8,
  datasetQuality: 0.95,
  leakageChecksPassed: true,
};

const pf15 = calculateEvidenceScore({ ...base, costAdjustedProfitFactor: 1.5 });
const pf2 = calculateEvidenceScore({ ...base, costAdjustedProfitFactor: 2.0 });
const pf25 = calculateEvidenceScore({ ...base, costAdjustedProfitFactor: 2.5 });
const pf1 = calculateEvidenceScore({ ...base, costAdjustedProfitFactor: 1.0 });

assert(
  pf15.components.costAdjustedPF === 0.8,
  "PF=1.5 should map to 0.8",
);
assert(
  pf2.components.costAdjustedPF === 1,
  "PF=2.0 should map to 1.0",
);
assert(
  pf25.components.costAdjustedPF === 1,
  "PF above 2.0 should remain capped at 1.0",
);
assert(
  pf1.components.costAdjustedPF === 0,
  "PF<=1.0 should contribute zero",
);

console.log("Result: 4 passed, 0 failed");
