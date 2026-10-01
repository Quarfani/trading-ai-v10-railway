/**
 * CONVICTION GATE ENGINE
 *
 * Implements the Master Prompt's "all gates must pass" semantics.
 * Gates can only veto. No lower-priority component may override a hard veto.
 */
export type GateName =
  | 'DATA_QUALITY'
  | 'REGIME'
  | 'MTF'
  | 'HISTORICAL_ANALOG'
  | 'EVIDENCE'
  | 'EXPECTED_VALUE'
  | 'RISK_REWARD'
  | 'FALSE_SIGNAL'
  | 'PORTFOLIO'
  | 'NEWS_MACRO';

export type GateStatus = 'PASS' | 'FAIL';

export interface GateResult {
  name: GateName;
  status: GateStatus;
  reason: string;
  hardVeto?: boolean;
}

export interface ConvictionDecision {
  decision: 'TRADE' | 'NO_TRADE';
  gates: GateResult[];
  failedGates: GateName[];
  hardVetoes: GateName[];
  reason: string;
}

const AUTHORITY: Record<GateName, number> = {
  DATA_QUALITY: 100,
  NEWS_MACRO: 95,
  PORTFOLIO: 90,
  RISK_REWARD: 85,
  REGIME: 80,
  MTF: 75,
  HISTORICAL_ANALOG: 70,
  EVIDENCE: 65,
  EXPECTED_VALUE: 60,
  FALSE_SIGNAL: 55,
};

export function evaluateConviction(
  gates: GateResult[],
): ConvictionDecision {
  const normalized = gates.map(gate => ({
    ...gate,
    hardVeto: gate.hardVeto ?? false,
  }));

  const failed = normalized
    .filter(g => g.status === 'FAIL')
    .sort((a, b) => AUTHORITY[b.name] - AUTHORITY[a.name]);

  if (failed.length > 0) {
    const hard = failed.filter(g => g.hardVeto);
    const primary = failed[0];

    return {
      decision: 'NO_TRADE',
      gates: normalized,
      failedGates: failed.map(g => g.name),
      hardVetoes: hard.map(g => g.name),
      reason:
        hard.length > 0
          ? `Hard veto: ${hard[0].name} — ${hard[0].reason}`
          : `Conviction gate failed: ${primary.name} — ${primary.reason}`,
    };
  }

  return {
    decision: 'TRADE',
    gates: normalized,
    failedGates: [],
    hardVetoes: [],
    reason: 'All conviction gates passed',
  };
}

export function orderGatesForEvaluation(
  gates: GateResult[],
): GateResult[] {
  return [...gates].sort(
    (a, b) => AUTHORITY[b.name] - AUTHORITY[a.name],
  );
}
