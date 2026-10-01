/**
 * FIRST-CLASS STRATEGY METADATA
 *
 * Describes deployment scope, versioned parameters, risk profile and evidence.
 * This does not grant production permission by itself.
 */
import { AssetClass, Timeframe } from '../market/market.types';

export type StrategyLifecycleState =
  | 'RESEARCH' | 'BACKTEST' | 'VALIDATION' | 'WALK_FORWARD'
  | 'MONTE_CARLO' | 'PAPER' | 'TESTNET' | 'SHADOW'
  | 'SMALL_CAPITAL' | 'PRODUCTION' | 'PAUSED' | 'REJECTED';

export interface StrategyScope {
  assetClasses: readonly AssetClass[];
  symbols: readonly string[];
  timeframes: readonly Timeframe[];
  regimes: readonly string[];
  sessions: readonly string[];
}

export interface StrategyRiskProfile {
  baseRiskFraction: number;
  minimumRiskReward: number;
  maximumDrawdown: number;
  maximumCorrelatedExposure?: number;
}

export interface StrategyEvidence {
  datasetVersion: string;
  costModelVersion: string;
  sampleSize: number;
  outOfSampleTrades: number;
  outOfSampleProfitFactor: number;
  walkForwardStability: number;
  parameterSensitivity: number;
  regimeCoverage: number;
  passed: boolean;
  evaluatedAt: number;
}

export interface StrategyDefinition {
  strategyId: string;
  name: string;
  version: string;
  enabled: boolean;
  lifecycle: StrategyLifecycleState;
  scope: StrategyScope;
  requiredData: readonly string[];
  parametersVersion: string;
  riskProfile: StrategyRiskProfile;
  evidence?: StrategyEvidence;
  createdAt: number;
  updatedAt: number;
}

export function validateStrategyDefinition(
  definition: StrategyDefinition,
): StrategyDefinition {
  if (!definition.strategyId.trim()) throw new Error('[StrategyDefinition] strategyId is required');
  if (!definition.name.trim()) throw new Error('[StrategyDefinition] name is required');
  if (!definition.version.trim()) throw new Error('[StrategyDefinition] version is required');
  if (!definition.parametersVersion.trim()) throw new Error('[StrategyDefinition] parametersVersion is required');

  const risk = definition.riskProfile;
  if (!Number.isFinite(risk.baseRiskFraction) || risk.baseRiskFraction <= 0 || risk.baseRiskFraction > 0.02) {
    throw new Error('[StrategyDefinition] baseRiskFraction must be > 0 and <= 0.02');
  }
  if (!Number.isFinite(risk.minimumRiskReward) || risk.minimumRiskReward < 0.5) {
    throw new Error('[StrategyDefinition] minimumRiskReward must be >= 0.5');
  }
  if (!Number.isFinite(risk.maximumDrawdown) || risk.maximumDrawdown <= 0 || risk.maximumDrawdown >= 1) {
    throw new Error('[StrategyDefinition] maximumDrawdown must be between 0 and 1');
  }

  return definition;
}
