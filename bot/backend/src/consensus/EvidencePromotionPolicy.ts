/** Shared evidence promotion policy for lifecycle and automated WFO. */
import { StrategyEvidence } from "./strategyDefinition";

export interface EvidencePromotionPolicy {
  minSampleSize: number;
  minOutOfSampleTrades: number;
  minOutOfSampleProfitFactor: number;
  minWalkForwardStability: number;
  minParameterSensitivity: number;
  minRegimeCoverage: number;
  maxAgeMs: number;
}

export const DEFAULT_EVIDENCE_PROMOTION_POLICY: EvidencePromotionPolicy = {
  minSampleSize: 100,
  minOutOfSampleTrades: 30,
  minOutOfSampleProfitFactor: 1.05,
  minWalkForwardStability: 0.5,
  minParameterSensitivity: 0.5,
  minRegimeCoverage: 0.5,
  maxAgeMs: 30 * 24 * 3_600_000,
};

export function evaluateEvidenceForPromotion(
  evidence: StrategyEvidence | undefined,
  policy: EvidencePromotionPolicy = DEFAULT_EVIDENCE_PROMOTION_POLICY,
  now = Date.now(),
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!evidence) return { passed: false, reasons: ["missing evidence"] };
  if (!evidence.passed) reasons.push("evidence.passed=false");
  if (!evidence.datasetVersion.trim()) reasons.push("datasetVersion missing");
  if (!evidence.costModelVersion.trim()) reasons.push("costModelVersion missing");
  if (!(evidence.sampleSize >= policy.minSampleSize)) reasons.push("sampleSize below policy");
  if (!(evidence.outOfSampleTrades >= policy.minOutOfSampleTrades)) reasons.push("outOfSampleTrades below policy");
  if (!(evidence.outOfSampleProfitFactor >= policy.minOutOfSampleProfitFactor)) reasons.push("outOfSampleProfitFactor below policy");
  if (!(evidence.walkForwardStability >= policy.minWalkForwardStability)) reasons.push("walkForwardStability below policy");
  if (!(evidence.parameterSensitivity >= policy.minParameterSensitivity)) reasons.push("parameterSensitivity below policy");
  if (!(evidence.regimeCoverage >= policy.minRegimeCoverage)) reasons.push("regimeCoverage below policy");
  if (!Number.isFinite(evidence.evaluatedAt) || evidence.evaluatedAt <= 0) {
    reasons.push("evaluatedAt missing");
  } else if (now - evidence.evaluatedAt > policy.maxAgeMs) {
    reasons.push("evidence is stale");
  }
  return { passed: reasons.length === 0, reasons };
}