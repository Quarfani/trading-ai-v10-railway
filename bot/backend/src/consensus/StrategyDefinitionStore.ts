/**
 * PERSISTENT STRATEGY DEFINITION STORE
 *
 * Stores the first-class strategy metadata and every lifecycle transition.
 * Runtime eligibility can later consume this store as a hard deployment gate.
 */
import { DatabaseManager } from '../database/DatabaseManager';
import {
  StrategyDefinition,
  StrategyLifecycleState,
} from './strategyDefinition';
import {
  promoteStrategy,
  promotionPolicyForTarget,
} from './StrategyLifecycle';
import {
  evaluateEvidenceForPromotion,
} from './EvidencePromotionPolicy';
import { EvidencePromotionPolicy, DEFAULT_EVIDENCE_PROMOTION_POLICY } from './EvidencePromotionPolicy';
import { EvidenceSnapshotStore } from '../analytics/EvidenceSnapshotStore';

type DefinitionRow = {
  strategyId: string;
  name: string;
  version: string;
  enabled: number;
  lifecycle: StrategyLifecycleState;
  assetClassesJson: string;
  symbolsJson: string;
  timeframesJson: string;
  regimesJson: string;
  sessionsJson: string;
  requiredDataJson: string;
  parametersVersion: string;
  baseRiskFraction: number;
  minimumRiskReward: number;
  maximumDrawdown: number;
  maximumCorrelatedExposure: number | null;
  evidenceJson: string | null;
  createdAt: number;
  updatedAt: number;
};

export class StrategyDefinitionStore {
  constructor(
    private readonly db: DatabaseManager,
    private readonly evidencePolicy: EvidencePromotionPolicy = DEFAULT_EVIDENCE_PROMOTION_POLICY,
    private readonly evidenceSnapshots = new EvidenceSnapshotStore(db),
  ) {}

  save(definition: StrategyDefinition): void {
    const payload = this.toRow(definition);

    this.db.raw().prepare(`
      INSERT INTO strategy_definitions (
        strategyId, name, version, enabled, lifecycle,
        assetClassesJson, symbolsJson, timeframesJson, regimesJson,
        sessionsJson, requiredDataJson, parametersVersion,
        baseRiskFraction, minimumRiskReward, maximumDrawdown,
        maximumCorrelatedExposure, evidenceJson, createdAt, updatedAt
      ) VALUES (
        @strategyId, @name, @version, @enabled, @lifecycle,
        @assetClassesJson, @symbolsJson, @timeframesJson, @regimesJson,
        @sessionsJson, @requiredDataJson, @parametersVersion,
        @baseRiskFraction, @minimumRiskReward, @maximumDrawdown,
        @maximumCorrelatedExposure, @evidenceJson, @createdAt, @updatedAt
      )
      ON CONFLICT(strategyId) DO UPDATE SET
        name=excluded.name,
        version=excluded.version,
        enabled=excluded.enabled,
        lifecycle=excluded.lifecycle,
        assetClassesJson=excluded.assetClassesJson,
        symbolsJson=excluded.symbolsJson,
        timeframesJson=excluded.timeframesJson,
        regimesJson=excluded.regimesJson,
        sessionsJson=excluded.sessionsJson,
        requiredDataJson=excluded.requiredDataJson,
        parametersVersion=excluded.parametersVersion,
        baseRiskFraction=excluded.baseRiskFraction,
        minimumRiskReward=excluded.minimumRiskReward,
        maximumDrawdown=excluded.maximumDrawdown,
        maximumCorrelatedExposure=excluded.maximumCorrelatedExposure,
        evidenceJson=excluded.evidenceJson,
        updatedAt=excluded.updatedAt
    `).run(payload);
  }

  getByName(name: string): StrategyDefinition | null {
    const row = this.db.raw().prepare(
      'SELECT * FROM strategy_definitions WHERE name=? ORDER BY updatedAt DESC LIMIT 1',
    ).get(name) as DefinitionRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  get(strategyId: string): StrategyDefinition | null {
    const row = this.db.raw().prepare(
      'SELECT * FROM strategy_definitions WHERE strategyId=?',
    ).get(strategyId) as DefinitionRow | undefined;

    return row ? this.fromRow(row) : null;
  }

  list(): StrategyDefinition[] {
    const rows = this.db.raw().prepare(
      'SELECT * FROM strategy_definitions ORDER BY strategyId',
    ).all() as DefinitionRow[];

    return rows.map(row => this.fromRow(row));
  }

  promote(
    strategyId: string,
    to: StrategyLifecycleState,
    reason: string,
    at = Date.now(),
  ): StrategyDefinition {
    const current = this.get(strategyId);
    if (!current) {
      throw new Error(
        `[StrategyDefinitionStore] unknown strategy "${strategyId}"`,
      );
    }

    if (
      to === 'SMALL_CAPITAL' ||
      to === 'PRODUCTION'
    ) {
      this.assertExactEvidenceSnapshots(current, to);
    }

    const result = promoteStrategy(
      current,
      to,
      reason,
      at,
      this.evidencePolicy,
    );

    this.db.raw().transaction(() => {
      this.save(result.definition);
      this.db.raw().prepare(`
        INSERT INTO strategy_lifecycle_transitions
          (strategyId, fromState, toState, at, reason)
        VALUES (?,?,?,?,?)
      `).run(
        strategyId,
        result.transition.from,
        result.transition.to,
        result.transition.at,
        result.transition.reason,
      );
    })();

    return result.definition;
  }

  private assertExactEvidenceSnapshots(
    definition: StrategyDefinition,
    target: StrategyLifecycleState,
  ): void {
    const symbols = [...definition.scope.symbols];
    const timeframes = [...definition.scope.timeframes];
    const targetPolicy = promotionPolicyForTarget(target, this.evidencePolicy);

    if (!symbols.length || !timeframes.length) {
      throw new Error(
        '[StrategyDefinitionStore] exact strategy evidence scope requires at least one symbol and timeframe',
      );
    }

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        const snapshot = this.evidenceSnapshots.latestForStrategy(
          definition.strategyId,
          symbol,
          timeframe,
        );

        if (!snapshot) {
          throw new Error(
            '[StrategyDefinitionStore] missing evidence snapshot for ' +
            definition.strategyId + '/' + symbol + '/' + timeframe,
          );
        }

        if (!snapshot.promoted) {
          throw new Error(
            '[StrategyDefinitionStore] evidence snapshot is not promoted for ' +
            definition.strategyId + '/' + symbol + '/' + timeframe,
          );
        }

        if (snapshot.strategyVersion !== definition.version) {
          throw new Error(
            '[StrategyDefinitionStore] evidence snapshot version is required and must match ' +
            definition.strategyId + '/' + symbol + '/' + timeframe,
          );
        }

        const snapshotEvidence = snapshot.evidence as any;
        const snapshotPromotion = evaluateEvidenceForPromotion(
          snapshotEvidence,
          targetPolicy,
        );
        if (!snapshotPromotion.passed) {
          throw new Error(
            '[StrategyDefinitionStore] evidence snapshot does not satisfy the ' +
            target + ' promotion policy for ' +
            definition.strategyId + '/' + symbol + '/' + timeframe +
            ': ' + snapshotPromotion.reasons.join('; '),
          );
        const snapshotMc = (snapshotEvidence as any)?.monteCarloStress;
        if (snapshotMc && ['SMALL_CAPITAL', 'PRODUCTION'].includes(target)) {
          if (
            Number.isFinite(snapshotMc.maxDDP95) &&
            snapshotMc.maxDDP95 > definition.riskProfile.maximumDrawdown
          ) {
            throw new Error(
              '[StrategyDefinitionStore] Monte Carlo P95 drawdown exceeds the strategy risk-profile maximumDrawdown for ' +
              definition.strategyId + '/' + symbol + '/' + timeframe,
            );
          }
        }

        const createdAt = snapshot.createdAt ?? 0;
        if (
          !Number.isFinite(createdAt) ||
          Date.now() - createdAt > this.evidencePolicy.maxAgeMs
        ) {
          throw new Error(
            '[StrategyDefinitionStore] evidence snapshot is stale for ' +
            definition.strategyId + '/' + symbol + '/' + timeframe,
          );
        }
      }
    }
  }

  getTransitions(strategyId: string): Array<{
    from: StrategyLifecycleState;
    to: StrategyLifecycleState;
    at: number;
    reason: string;
  }> {
    const rows = this.db.raw().prepare(`
      SELECT fromState, toState, at, reason
      FROM strategy_lifecycle_transitions
      WHERE strategyId=?
      ORDER BY at ASC, id ASC
    `).all(strategyId) as Array<{
      fromState: StrategyLifecycleState;
      toState: StrategyLifecycleState;
      at: number;
      reason: string;
    }>;

    return rows.map(row => ({
      from: row.fromState,
      to: row.toState,
      at: row.at,
      reason: row.reason,
    }));
  }

  private toRow(definition: StrategyDefinition) {
    return {
      strategyId: definition.strategyId,
      name: definition.name,
      version: definition.version,
      enabled: definition.enabled ? 1 : 0,
      lifecycle: definition.lifecycle,
      assetClassesJson: JSON.stringify(definition.scope.assetClasses),
      symbolsJson: JSON.stringify(definition.scope.symbols),
      timeframesJson: JSON.stringify(definition.scope.timeframes),
      regimesJson: JSON.stringify(definition.scope.regimes),
      sessionsJson: JSON.stringify(definition.scope.sessions),
      requiredDataJson: JSON.stringify(definition.requiredData),
      parametersVersion: definition.parametersVersion,
      baseRiskFraction: definition.riskProfile.baseRiskFraction,
      minimumRiskReward: definition.riskProfile.minimumRiskReward,
      maximumDrawdown: definition.riskProfile.maximumDrawdown,
      maximumCorrelatedExposure:
        definition.riskProfile.maximumCorrelatedExposure ?? null,
      evidenceJson:
        definition.evidence
          ? JSON.stringify(definition.evidence)
          : null,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    };
  }

  private fromRow(row: DefinitionRow): StrategyDefinition {
    return {
      strategyId: row.strategyId,
      name: row.name,
      version: row.version,
      enabled: Boolean(row.enabled),
      lifecycle: row.lifecycle,
      scope: {
        assetClasses: JSON.parse(row.assetClassesJson),
        symbols: JSON.parse(row.symbolsJson),
        timeframes: JSON.parse(row.timeframesJson),
        regimes: JSON.parse(row.regimesJson),
        sessions: JSON.parse(row.sessionsJson),
      },
      requiredData: JSON.parse(row.requiredDataJson),
      parametersVersion: row.parametersVersion,
      riskProfile: {
        baseRiskFraction: row.baseRiskFraction,
        minimumRiskReward: row.minimumRiskReward,
        maximumDrawdown: row.maximumDrawdown,
        maximumCorrelatedExposure:
          row.maximumCorrelatedExposure ?? undefined,
      },
      evidence: row.evidenceJson
        ? JSON.parse(row.evidenceJson)
        : undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
