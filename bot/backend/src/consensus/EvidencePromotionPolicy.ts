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
  requireMonteCarlo: boolean;
  maxMonteCarloDD95: number;
  maxMonteCarloRuinProbability: number;
  maxMonteCarloUnrecoveredRate: number;
}

export const DEFAULT_EVIDENCE_PROMOTION_POLICY: EvidencePromotionPolicy = {
  minSampleSize: 100,
  minOutOfSampleTrades: 30,
  minOutOfSampleProfitFactor: 1.05,
  minWalkForwardStability: 0.5,
  minParameterSensitivity: 0.5,
  minRegimeCoverage: 0.5,
  maxAgeMs: 30 * 24 * 3_600_000,
  requireMonteCarlo: false,
  maxMonteCarloDD95: 0.30,
  maxMonteCarloRuinProbability: 0.05,
  maxMonteCarloUnrecoveredRate: 0.25,
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
  if (policy.requireMonteCarlo) {
    const mc = evidence.monteCarloStress;
    if (!mc) {
      reasons.push("missing Monte Carlo stress evidence");
    } else {
      if (!(mc.maxDDP95 <= policy.maxMonteCarloDD95)) {
        reasons.push("Monte Carlo P95 drawdown above policy");
      }
      if (!(mc.probabilityRuin <= policy.maxMonteCarloRuinProbability)) {
        reasons.push("Monte Carlo ruin probability above policy");
      }
      if (!(mc.unrecoveredRate <= policy.maxMonteCarloUnrecoveredRate)) {
        reasons.push("Monte Carlo unrecovered rate above policy");
      }
    }
  }

  if (!Number.isFinite(evidence.evaluatedAt) || evidence.evaluatedAt <= 0) {
    reasons.push("evaluatedAt missing");
  } else if (now - evidence.evaluatedAt > policy.maxAgeMs) {
    reasons.push("evidence is stale");
  }
  return { passed: reasons.length === 0, reasons };
}