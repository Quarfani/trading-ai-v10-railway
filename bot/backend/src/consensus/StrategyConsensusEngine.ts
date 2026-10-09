/**
 * STRATEGY CONSENSUS ENGINE â€” v7.1
 *
 * Main fixes:
 *
 * [FIX-1] WEIGHT BOOTSTRAPPING
 *   New strategies must be able to participate before they have trade history.
 *   A neutral bootstrap win-rate prior is used instead of treating unknown
 *   performance as a 10% win-rate floor.
 *
 * [FIX-2] WEIGHT COMPUTED ONCE
 *   Each strategy weight is computed once and stored in VoteDetail.
 *
 * [FIX-3] MINIMUM VOTERS / ACTIVE STRATEGIES
 *   The engine requires the configured minimum number of active strategies.
 *
 * [FIX-4] WEIGHTED CONFLICT RESOLUTION
 *   BUY and SELL may coexist. The winning side is selected by weighted support
 *   and dominance instead of an automatic conflict block.
 *
 * [FIX-5] CONSENSUS DIAGNOSTICS
 *   Railway logs now expose:
 *   - total BUY weight
 *   - total SELL weight
 *   - total weight
 *   - minimum required weight
 *   - vote count
 *   - per-strategy confidence
 *   - per-strategy weight
 *   - trade history
 *   - rolling win rate
 *   - Sharpe ratio
 */

import {
  ConsensusResult,
  ConsensusOutcome,
  BlockReason,
  VoteDetail,
  StrategySignal,
  StrategyContext,
  ConsensusConfig,
  DEFAULT_CONSENSUS_CONFIG,
} from './types';

import { StrategyRegistry } from './StrategyRegistry';
import { PerformanceGate } from './PerformanceGate';
import { Signal } from '../types/trading.types';
import { Logger } from '../utils/Logger';
import { evaluateStrategyEligibility } from './StrategyEligibility';

// Neutral bootstrap Sharpe for new strategies.
// It allows participation without pretending the strategy already
// has a proven historical Sharpe ratio.
const BOOTSTRAP_SHARPE = 0.5;

// Neutral bootstrap win-rate prior for strategies without history.
const BOOTSTRAP_WIN_RATE = 0.5;

// Conservative maximum contribution of one fresh strategy.
const NEW_STRATEGY_MAX_WEIGHT = 0.20;
const SINGLE_STRATEGY_MIN_CONFIDENCE = 0.72;
// A single high-confidence voter may meet half the aggregate-weight threshold,
// but never bypass the confidence, dominance, or later risk gates.
const SINGLE_STRATEGY_WEIGHT_FACTOR = 0.5;

export class StrategyConsensusEngine {
  private readonly logger = new Logger('ConsensusEngine');
  private readonly gate: PerformanceGate;
  private readonly cfg: ConsensusConfig;

  constructor(
    private readonly registry: StrategyRegistry,
    cfg: Partial<ConsensusConfig> = {},
  ) {
    this.cfg = {
      ...DEFAULT_CONSENSUS_CONFIG,
      ...cfg,
      gate: {
        ...DEFAULT_CONSENSUS_CONFIG.gate,
        ...(cfg.gate ?? {}),
      },
    };

    this.gate = new PerformanceGate(registry, this.cfg);
  }

  run(ctx: StrategyContext): ConsensusResult {
    const t0 = Date.now();
    const reasoning: string[] = [];

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 1: Performance gate
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const gateResult = this.gate.evaluate();

    for (const d of gateResult.disabled) {
      reasoning.push(
        `[GATE_DISABLED] ${d.strategy}: ${d.failures.join(', ')}`,
      );
    }

    for (const r of gateResult.reenabled) {
      reasoning.push(`[GATE_RECOVERED] ${r}`);
    }

    for (const s of gateResult.skipped) {
      reasoning.push(`[GATE_SKIPPED] ${s}: insufficient history`);
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 2: Active strategies
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const activeEntries = this.registry.getActive();

    const eligibleEntries = activeEntries.filter(entry => {
      const result = evaluateStrategyEligibility(entry.definition, ctx);
      if (!result.allowed) {
        reasoning.push(`[SCOPE_BLOCKED] ${entry.strategy.name}: ${result.reason}`);
        this.logger.info(
          `[CONSENSUS_SCOPE_BLOCK] ${ctx.symbol} ${ctx.timeframe} strategy=${entry.strategy.name} reason=${result.reason}`,
        );
      }
      return result.allowed;
    });

    const disabledSummary = this.registry
      .getDisabled()
      .map(d => ({
        name: d.name,
        reason: d.reason,
      }));

    if (eligibleEntries.length < this.cfg.minimum_active_strategies) {
      reasoning.push(
        `[NO_ACTIVE] Eligible=${eligibleEntries.length} ` +
        `< min=${this.cfg.minimum_active_strategies}`,
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} ` +
        `reason=NO_ACTIVE_STRATEGIES ` +
        `eligible=${eligibleEntries.length} ` +
        `minimum=${this.cfg.minimum_active_strategies}`,
      );

      return this.noTrade(
        'NO_ACTIVE_STRATEGIES',
        0,
        0,
        [],
        disabledSummary,
        reasoning,
        t0,
      );
    }

    reasoning.push(
      `[ACTIVE] count=${activeEntries.length}: ` +
      `${eligibleEntries.map(e => e.strategy.name).join(', ')}`,
    );

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 3: Generate signals
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const votes: VoteDetail[] = [];
    const buySignals: StrategySignal[] = [];
    const sellSignals: StrategySignal[] = [];

    for (const entry of eligibleEntries) {
      let ss: StrategySignal;

      try {
        ss = entry.strategy.generate_signal(ctx);
      } catch (e: any) {
        this.logger.error(
          `Strategy ${entry.strategy.name} threw: ${e?.message ?? String(e)}`,
        );
        continue;
      }

      // Reject malformed plugin output before any weight or direction math.
      if (ss.signal !== 'BUY' && ss.signal !== 'SELL' && ss.signal !== 'NONE') {
        reasoning.push(`[INVALID_STRATEGY_SIGNAL] ${entry.strategy.name}: unsupported vote`);
        this.logger.warn(`[CONSENSUS_SKIP] ${ctx.symbol} strategy=${entry.strategy.name} reason=invalid_vote`);
        continue;
      }
      if (
        !Number.isFinite(ss.confidence) ||
        ss.confidence < 0 ||
        ss.confidence > 1
      ) {
        reasoning.push(`[INVALID_STRATEGY_CONFIDENCE] ${entry.strategy.name}: confidence must be finite and in [0,1]`);
        this.logger.warn(`[CONSENSUS_SKIP] ${ctx.symbol} strategy=${entry.strategy.name} reason=invalid_confidence`);
        continue;
      }

      // Attach current strategy metrics to the generated signal.
      ss.metrics = entry.metrics;

      if (ss.signal === 'NONE') {
  reasoning.push(
    `[VOTE_NONE] ${ss.strategy_name}: no signal`,
  );

  this.logger.info(
    `[CONSENSUS_NONE] ${ctx.symbol} ` +
    `strategy=${ss.strategy_name} ` +
    `reason=no_signal`
  );

  continue;
}

      // Determine whether this strategy is still in bootstrap mode.
      const isNew =
        entry.metrics.total_trades <
        this.cfg.gate.min_trades_for_gate;

      // Compute the weight once. Invalid metrics must not poison aggregate totals.
      const weight = this.computeWeight(ss, isNew);
      if (!Number.isFinite(weight) || weight <= 0) {
        reasoning.push(`[INVALID_STRATEGY_WEIGHT] ${entry.strategy.name}: weight must be finite and positive`);
        this.logger.warn(`[CONSENSUS_SKIP] ${ctx.symbol} strategy=${entry.strategy.name} reason=invalid_weight`);
        continue;
      }

      votes.push({
        strategy_name: ss.strategy_name,
        vote: ss.signal,
        confidence: ss.confidence,
        weight,
        metrics: ss.metrics,
      });

      reasoning.push(
        JSON.stringify({
          event: 'VOTE_CAST',
          strategy: ss.strategy_name,
          vote: ss.signal,
          confidence: Number(ss.confidence).toFixed(4),
          weight: weight.toFixed(6),
          new: isNew,
          metrics: {
            sharpe: Number(ss.metrics.sharpe_ratio).toFixed(3),
            rolling_wr: Number(
              ss.metrics.rolling_win_rate,
            ).toFixed(3),
            total_trades: ss.metrics.total_trades,
          },
        }),
      );

      if (ss.signal === 'BUY') {
        buySignals.push(ss);
      }

      if (ss.signal === 'SELL') {
        sellSignals.push(ss);
      }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 4: Weighted conflict resolution
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    if (buySignals.length > 0 && sellSignals.length > 0) {
      reasoning.push(
        `[CONFLICT_DETECTED] ` +
        `BUY=${buySignals.length} ` +
        `SELL=${sellSignals.length} -> weighted resolution`,
      );
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 5: Weighted totals
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const total_buy_weight = votes
      .filter(v => v.vote === 'BUY')
      .reduce((sum, v) => sum + v.weight, 0);

    const total_sell_weight = votes
      .filter(v => v.vote === 'SELL')
      .reduce((sum, v) => sum + v.weight, 0);

    const total_weight =
      total_buy_weight + total_sell_weight;

    if (
      !Number.isFinite(total_buy_weight) ||
      !Number.isFinite(total_sell_weight) ||
      !Number.isFinite(total_weight)
    ) {
      reasoning.push('[NON_FINITE_CONSENSUS_WEIGHT] aggregate vote weight is invalid');
      this.logger.error(`[CONSENSUS_BLOCK] ${ctx.symbol} reason=NON_FINITE_CONSENSUS_WEIGHT`);
      return this.noTrade(
        'PERFORMANCE_GATE_FAILED',
        0,
        0,
        [],
        disabledSummary,
        reasoning,
        t0,
      );
    }

    const singleHighConfidenceVote =
      votes.length === 1 &&
      votes[0].weight > 0 &&
      votes[0].confidence >= SINGLE_STRATEGY_MIN_CONFIDENCE;
    const minimumRequiredWeight = singleHighConfidenceVote
      ? this.cfg.minimum_total_weight * SINGLE_STRATEGY_WEIGHT_FACTOR
      : this.cfg.minimum_total_weight;

    reasoning.push(
      `[WEIGHTS] ` +
      `buy=${total_buy_weight.toFixed(6)} ` +
      `sell=${total_sell_weight.toFixed(6)} ` +
      `total=${total_weight.toFixed(6)}`,
    );

    // Railway diagnostic log.
    this.logger.info(
      `[CONSENSUS_DEBUG] ${ctx.symbol} ` +
      `buy=${total_buy_weight.toFixed(6)} ` +
      `sell=${total_sell_weight.toFixed(6)} ` +
      `total=${total_weight.toFixed(6)} ` +
      `minimum=${minimumRequiredWeight.toFixed(6)} ` +
      `votes=${votes.length} ` +
      `active=${activeEntries.length}`,
    );

    // Per-strategy diagnostic logs.
    for (const vote of votes) {
      this.logger.info(
        `[CONSENSUS_VOTE] ` +
        `${ctx.symbol} ` +
        `strategy=${vote.strategy_name} ` +
        `side=${vote.vote} ` +
        `confidence=${Number(vote.confidence).toFixed(4)} ` +
        `weight=${vote.weight.toFixed(6)} ` +
        `trades=${vote.metrics.total_trades} ` +
        `rollingWR=${Number(
          vote.metrics.rolling_win_rate,
        ).toFixed(4)} ` +
        `sharpe=${Number(
          vote.metrics.sharpe_ratio,
        ).toFixed(4)}`,
      );
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 6: Minimum total weight

    if (total_weight < minimumRequiredWeight) {
      reasoning.push(
        `[INSUFFICIENT_WEIGHT] total=${total_weight.toFixed(4)} < min=${minimumRequiredWeight}`,
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} ` +
        `reason=INSUFFICIENT_WEIGHT total=${total_weight.toFixed(6)} ` +
        `minimum=${minimumRequiredWeight.toFixed(6)} configuredMinimum=${this.cfg.minimum_total_weight.toFixed(6)} ` +
        `buy=${total_buy_weight.toFixed(6)} sell=${total_sell_weight.toFixed(6)} ` +
        `votes=${votes.length}`,
      );

      return this.noTrade(
        'INSUFFICIENT_WEIGHT',
        total_buy_weight,
        total_sell_weight,
        votes,
        disabledSummary,
        reasoning,
        t0,
      );
    }

    // Step 7: Dominance
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const winningSide: 'BUY' | 'SELL' =
      total_buy_weight >= total_sell_weight
        ? 'BUY'
        : 'SELL';

    const winningWeight =
      winningSide === 'BUY'
        ? total_buy_weight
        : total_sell_weight;

    const dominance_ratio =
      total_weight > 0
        ? winningWeight / total_weight
        : 0;

    reasoning.push(
      `[DOMINANCE] ` +
      `side=${winningSide} ` +
      `ratio=${dominance_ratio.toFixed(4)} ` +
      `threshold=${this.cfg.dominance_ratio}`,
    );

    if (
      dominance_ratio <
      this.cfg.dominance_ratio
    ) {
      reasoning.push(
        `[LOW_DOMINANCE] ` +
        `${(dominance_ratio * 100).toFixed(1)}% ` +
        `< ${(this.cfg.dominance_ratio * 100).toFixed(1)}%`,
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} ` +
        `reason=LOW_DOMINANCE ` +
        `side=${winningSide} ` +
        `dominance=${dominance_ratio.toFixed(6)} ` +
        `threshold=${this.cfg.dominance_ratio.toFixed(6)} ` +
        `buy=${total_buy_weight.toFixed(6)} ` +
        `sell=${total_sell_weight.toFixed(6)}`,
      );

      return this.noTrade(
        'LOW_DOMINANCE',
        total_buy_weight,
        total_sell_weight,
        votes,
        disabledSummary,
        reasoning,
        t0,
      );
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 8: Single-strategy high-confidence gate
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const winnersVotes = votes.filter(
      v => v.vote === winningSide,
    );

    if (
      winnersVotes.length === 1 &&
      winnersVotes[0].confidence < SINGLE_STRATEGY_MIN_CONFIDENCE
    ) {
      reasoning.push(
        `[SINGLE_LOW_CONF] ` +
        `single strategy conf ` +
        `${winnersVotes[0].confidence.toFixed(3)} < ${SINGLE_STRATEGY_MIN_CONFIDENCE}`,
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} ` +
        `reason=SINGLE_STRATEGY_LOW_CONFIDENCE ` +
        `strategy=${winnersVotes[0].strategy_name} ` +
        `confidence=${winnersVotes[0].confidence.toFixed(4)}`,
      );

      return this.noTrade(
        'SINGLE_STRATEGY_LOW_CONFIDENCE',
        total_buy_weight,
        total_sell_weight,
        votes,
        disabledSummary,
        reasoning,
        t0,
      );
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 9: Select best signal
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const winnerSignals = (
      winningSide === 'BUY'
        ? buySignals
        : sellSignals
    ).filter(
      s => s.raw_signal !== null,
    );

    if (!winnerSignals.length) {
      reasoning.push(
        '[NO_VALID_SIGNAL] no raw signal from winning strategies',
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} ` +
        `reason=NO_VALID_SIGNAL ` +
        `side=${winningSide}`,
      );

      return this.noTrade(
        'INSUFFICIENT_WEIGHT',
        total_buy_weight,
        total_sell_weight,
        votes,
        disabledSummary,
        reasoning,
        t0,
      );
    }

    // Use the precomputed weights.
    const best = winnerSignals.reduce(
      (a, b) => {
        const wa =
          winnersVotes.find(
            v => v.strategy_name === a.strategy_name,
          )?.weight ?? 0;

        const wb =
          winnersVotes.find(
            v => v.strategy_name === b.strategy_name,
          )?.weight ?? 0;

        return wa * a.confidence >
          wb * b.confidence
          ? a
          : b;
      },
    );

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 10: Build merged consensus signal
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const mergedSignal: Signal = {
      ...best.raw_signal!,
      source: winnersVotes
        .map(v => v.strategy_name)
        .join('+'),

      reason:
        `[CONSENSUS:${winningSide}] ` +
        winnersVotes
          .map(
            v =>
              `${v.strategy_name}` +
              `(w=${v.weight.toFixed(4)})`,
          )
          .join(' | '),

      confidence: Math.min(
        0.95,
        best.confidence,
      ),
    };

    reasoning.push(
      `[APPROVED] ` +
      `${winningSide} ${ctx.symbol} ` +
      `weight=${total_weight.toFixed(4)} ` +
      `dom=${dominance_ratio.toFixed(3)} ` +
      `voters=${winnersVotes.length}`,
    );

    this.logger.info(
      JSON.stringify({
        event: 'CONSENSUS_APPROVED',
        symbol: ctx.symbol,
        side: winningSide,
        total_weight: total_weight.toFixed(4),
        buy_weight: total_buy_weight.toFixed(4),
        sell_weight: total_sell_weight.toFixed(4),
        dominance: dominance_ratio.toFixed(4),
        voters: winnersVotes.length,
        active_strategies: activeEntries.length,
      }),
    );

    return {
      outcome: winningSide,
      block_reason: 'APPROVED',
      signal: mergedSignal,

      total_buy_weight,
      total_sell_weight,
      dominance_ratio,

      active_strategies: activeEntries.length,

      votes,

      disabled_strategies:
        disabledSummary,

      reasoning,

      timestamp: ctx.timestamp,

      duration_ms:
        Date.now() - t0,
    };
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Weight formula
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Compute strategy vote weight.
   *
   * Established strategy:
   *
   *   weight =
   *     max(0, sharpe)
   *     Ã— rolling_win_rate
   *     Ã— confidence
   *
   * New strategy:
   *
   *   weight =
   *     BOOTSTRAP_SHARPE
   *     Ã— BOOTSTRAP_WIN_RATE
   *     Ã— confidence
   *
   * New strategies are capped so that one fresh strategy
   * cannot dominate the whole consensus.
   */
  private computeWeight(
    ss: StrategySignal,
    isNew: boolean,
  ): number {
    const conf = Math.max(
      0,
      Math.min(1, ss.confidence),
    );

    // Fresh strategy:
    // use neutral priors instead of the old 10% win-rate floor.
    if (isNew) {
      const weight =
        BOOTSTRAP_SHARPE *
        BOOTSTRAP_WIN_RATE *
        conf;

      return Math.min(
        weight,
        NEW_STRATEGY_MAX_WEIGHT,
      );
    }

    // Established strategy:
    // use actual historical performance.
    const sharpe = Math.max(
      0,
      ss.metrics.sharpe_ratio,
    );

    const rollWR = Math.max(
      0.10,
      Math.min(
        1,
        ss.metrics.rolling_win_rate,
      ),
    );

    return sharpe * rollWR * conf;
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // NO_TRADE factory
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private noTrade(
    reason: BlockReason,
    buyW: number,
    sellW: number,
    votes: VoteDetail[],
    disabled: Array<{
      name: string;
      reason: string;
    }>,
    reasoning: string[],
    t0: number,
  ): ConsensusResult {
    return {
      outcome: 'NO_TRADE',

      block_reason: reason,

      signal: null,

      total_buy_weight: buyW,

      total_sell_weight: sellW,

      dominance_ratio: 0,

      active_strategies:
        this.registry.getActive().length,

      votes,

      disabled_strategies: disabled,

      reasoning,

      timestamp: Date.now(),

      duration_ms:
        Date.now() - t0,
    };
  }
}
