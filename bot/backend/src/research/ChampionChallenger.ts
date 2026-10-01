/**
 * CHAMPION / CHALLENGER CONTROL
 *
 * Challenger replacement is evidence-driven and isolated from the execution
 * path. Small-sample or non-robust improvements cannot replace a champion.
 */
import { calculateEvidenceScore, EvidenceInput } from './EvidenceScore';

export interface StrategyCandidate {
  strategyId: string;
  version: string;
  evidence: EvidenceInput;
}

export interface ChampionDecision {
  replace: boolean;
  championScore: number;
  challengerScore: number;
  reason: string;
}

export function evaluateChampionChallenger(
  champion: StrategyCandidate,
  challenger: StrategyCandidate,
  minimumOosTrades = 200,
  minimumScoreAdvantage = 0.05,
): ChampionDecision {
  const championEvidence = calculateEvidenceScore(
    champion.evidence,
    minimumOosTrades,
  );
  const challengerEvidence = calculateEvidenceScore(
    challenger.evidence,
    minimumOosTrades,
  );

  if (!challengerEvidence.passed) {
    return {
      replace: false,
      championScore: championEvidence.score,
      challengerScore: challengerEvidence.score,
      reason: 'Challenger evidence gate not passed',
    };
  }

  if (!championEvidence.passed) {
    return {
      replace: true,
      championScore: championEvidence.score,
      challengerScore: challengerEvidence.score,
      reason: 'Current champion lacks sufficient evidence',
    };
  }

  if (
    challengerEvidence.score <
    championEvidence.score + minimumScoreAdvantage
  ) {
    return {
      replace: false,
      championScore: championEvidence.score,
      challengerScore: challengerEvidence.score,
      reason: 'Challenger advantage is below replacement margin',
    };
  }

  return {
    replace: true,
    championScore: championEvidence.score,
    challengerScore: challengerEvidence.score,
    reason: 'Challenger passed evidence gate and exceeded champion margin',
  };
}
