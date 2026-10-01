import { DEFAULT_EVIDENCE_PROMOTION_POLICY, evaluateEvidenceForPromotion } from "../consensus/EvidencePromotionPolicy";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = Date.now();
const evidence = {
  datasetVersion:"data-v1",
  costModelVersion:"cost-v1",
  sampleSize:100,
  outOfSampleTrades:50,
  outOfSampleProfitFactor:1.2,
  walkForwardStability:0.6,
  parameterSensitivity:0.7,
  regimeCoverage:0.8,
  passed:true,
  evaluatedAt:now,
};
assert(evaluateEvidenceForPromotion(evidence).passed, "valid fresh evidence should pass");
assert(!evaluateEvidenceForPromotion({...evidence, passed:false}).passed, "failed evidence must block");
assert(!evaluateEvidenceForPromotion({...evidence, evaluatedAt:now-DEFAULT_EVIDENCE_PROMOTION_POLICY.maxAgeMs-1}).passed, "stale evidence must block");
assert(!evaluateEvidenceForPromotion({...evidence, outOfSampleProfitFactor:0.5}).passed, "low PF must block");
console.log("Result: 5 passed, 0 failed");