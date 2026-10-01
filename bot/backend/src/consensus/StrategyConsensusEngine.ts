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

// Neutral bootstrap Sharpe for new strategies.
// It allows participation without pretending the strategy already
// has a proven historical Sharpe ratio.
const BOOTSTRAP_SHARPE = 0.5;

// Neutral bootstrap win-rate prior for strategies without history.
const BOOTSTRAP_WIN_RATE = 0.5;

// Conservative maximum contribution of one fresh strategy.
const NEW_STRATEGY_MAX_WEIGHT = 0.20;

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

    const disabledSummary = this.registry
      .getDisabled()
      .map(d => ({
        name: d.name,
        reason: d.reason,
      }));

    if (activeEntries.length < this.cfg.minimum_active_strategies) {
      reasoning.push(
        `[NO_ACTIVE] Active=${activeEntries.length} ` +
        `< min=${this.cfg.minimum_active_strategies}`,
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} ` +
        `reason=NO_ACTIVE_STRATEGIES ` +
        `active=${activeEntries.length} ` +
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
      `${activeEntries.map(e => e.strategy.name).join(', ')}`,
    );

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Step 3: Generate signals
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    const votes: VoteDetail[] = [];
    const buySignals: StrategySignal[] = [];
    const sellSignals: StrategySignal[] = [];

    for (const entry of activeEntries) {
      let ss: StrategySignal;

      try {
        ss = entry.strategy.generate_signal(ctx);
      } catch (e: any) {
        this.logger.error(
          `Strategy ${entry.strategy.name} threw: ${e?.message ?? String(e)}`,
        );
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

      // Compute the weight once.
      const weight = this.computeWeight(ss, isNew);

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
      `minimum=${this.cfg.minimum_total_weight.toFixed(6)} ` +
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
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    if (
      total_weight < this.cfg.minimum_total_weight
    ) {
      reasoning.push(
        `[INSUFFICIENT_WEIGHT] total=${total_weight.toFixed(4)} < min=${this.cfg.minimum_total_weight}`,
      );

      this.logger.info(
        `[CONSENSUS_BLOCK] ${ctx.symbol} reason=INSUFFICIENT_WEIGHT total=${total_weight.toFixed(6)} minimum=${this.cfg.minimum_total_weight.toFixed(6)} buy=${total_buy_weight.toFixed(6)} sell=${total_sell_weight.toFixed(6)} votes=${votes.length}`,
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


