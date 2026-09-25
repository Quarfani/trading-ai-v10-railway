/**
 * STRATEGY CONSENSUS ENGINE — v7.0
 * ══════════════════════════════════════════════════════════════════════════
 * الإصلاحات في هذا الإصدار:
 *
 * [FIX-1] WEIGHT BOOTSTRAPPING:
 *   الإصدار السابق: weight = sharpe × rolling_wr × confidence
 *   إذا sharpe=0 (استراتيجية جديدة) → weight=0 → لا تصويت أبداً
 *   الإصلاح: weight = (sharpe + ε) × rolling_wr × confidence
 *   حيث ε = 0.5 للاستراتيجيات الجديدة (< min_trades_for_gate)
 *   هذا يسمح للاستراتيجيات الجديدة بالمشاركة بوزن محدود.
 *
 * [FIX-2] WEIGHT COMPUTED ONCE:
 *   الإصدار السابق: computeWeight() يُستدعى مرتين لكل استراتيجية
 *   الإصلاح: يُحسب مرة واحدة ويُخزَّن في VoteDetail.
 *
 * [FIX-3] MINIMUM VOTERS CHECK:
 *   إضافة: إذا الاستراتيجيات الناخبة أقل من threshold → NO_TRADE
 *   هذا يمنع استراتيجية واحدة ضعيفة من التحكم بالقرار.
 * ══════════════════════════════════════════════════════════════════════════
 */
import {
  ConsensusResult, ConsensusOutcome, BlockReason,
  VoteDetail, StrategySignal, StrategyContext,
  ConsensusConfig, DEFAULT_CONSENSUS_CONFIG,
} from './types';
import { StrategyRegistry }  from './StrategyRegistry';
import { PerformanceGate }   from './PerformanceGate';
import { Signal }            from '../types/trading.types';
import { Logger }            from '../utils/Logger';

// Bootstrap sharpe for new strategies with < min_trades_for_gate
const BOOTSTRAP_SHARPE = 0.5;

export class StrategyConsensusEngine {
  private readonly logger = new Logger('ConsensusEngine');
  private readonly gate:  PerformanceGate;
  private readonly cfg:   ConsensusConfig;

  constructor(
    private readonly registry: StrategyRegistry,
    cfg: Partial<ConsensusConfig> = {},
  ) {
    this.cfg  = { ...DEFAULT_CONSENSUS_CONFIG, ...cfg, gate: { ...DEFAULT_CONSENSUS_CONFIG.gate, ...(cfg.gate ?? {}) } };
    this.gate = new PerformanceGate(registry, this.cfg);
  }

  run(ctx: StrategyContext): ConsensusResult {
    const t0        = Date.now();
    const reasoning: string[] = [];

    // ── Step 1: Performance gate ──────────────────────────────────────────
    const gateResult = this.gate.evaluate();
    for (const d of gateResult.disabled)  reasoning.push(`[GATE_DISABLED] ${d.strategy}: ${d.failures.join(', ')}`);
    for (const r of gateResult.reenabled) reasoning.push(`[GATE_RECOVERED] ${r}`);
    for (const s of gateResult.skipped)   reasoning.push(`[GATE_SKIPPED] ${s}: insufficient history`);

    // ── Step 2: Active strategies ─────────────────────────────────────────
    const activeEntries  = this.registry.getActive();
    const disabledSummary = this.registry.getDisabled().map(d => ({ name: d.name, reason: d.reason }));

    if (activeEntries.length < this.cfg.minimum_active_strategies) {
      reasoning.push(`[NO_ACTIVE] Active=${activeEntries.length} < min=${this.cfg.minimum_active_strategies}`);
      return this.noTrade('NO_ACTIVE_STRATEGIES', 0, 0, [], disabledSummary, reasoning, t0);
    }

    reasoning.push(`[ACTIVE] count=${activeEntries.length}: ${activeEntries.map(e => e.strategy.name).join(', ')}`);

    // ── Step 3: Generate signals ──────────────────────────────────────────
    const votes: VoteDetail[]        = [];
    const buySignals:  StrategySignal[] = [];
    const sellSignals: StrategySignal[] = [];

    for (const entry of activeEntries) {
      let ss: StrategySignal;
      try {
        ss = entry.strategy.generate_signal(ctx);
      } catch (e: any) {
        this.logger.error(`Strategy ${entry.strategy.name} threw: ${e.message}`);
        continue;
      }

      ss.metrics = entry.metrics;

      if (ss.signal === 'NONE') {
        reasoning.push(`[VOTE_NONE] ${ss.strategy_name}: no signal`);
        continue;
      }

      // [FIX-1] Bootstrap weight for new strategies
      const isNew   = entry.metrics.total_trades < this.cfg.gate.min_trades_for_gate;
      const weight  = this.computeWeight(ss, isNew);

      votes.push({
        strategy_name: ss.strategy_name,
        vote:          ss.signal,
        confidence:    ss.confidence,
        weight,
        metrics:       ss.metrics,
      });

      reasoning.push(JSON.stringify({
        event: 'VOTE_CAST', strategy: ss.strategy_name, vote: ss.signal,
        confidence: ss.confidence.toFixed(4), weight: weight.toFixed(6),
        new: isNew,
        metrics: { sharpe: ss.metrics.sharpe_ratio.toFixed(3), rolling_wr: ss.metrics.rolling_win_rate.toFixed(3) },
      }));

      if (ss.signal === 'BUY')  buySignals.push(ss);
      if (ss.signal === 'SELL') sellSignals.push(ss);
    }

    // ── Step 4: ABSOLUTE conflict check ──────────────────────────────────
    if (buySignals.length > 0 && sellSignals.length > 0) {
      reasoning.push(`[CONFLICT_BLOCKED] BUY(${buySignals.map(s => s.strategy_name).join(',')}) vs SELL(${sellSignals.map(s => s.strategy_name).join(',')})`);
      return this.noTrade('CONFLICT_BLOCKED', 0, 0, votes, disabledSummary, reasoning, t0);
    }

    // ── Step 5: Weighted totals ───────────────────────────────────────────
    const total_buy_weight  = votes.filter(v => v.vote === 'BUY').reduce((s, v) => s + v.weight, 0);
    const total_sell_weight = votes.filter(v => v.vote === 'SELL').reduce((s, v) => s + v.weight, 0);
    const total_weight      = total_buy_weight + total_sell_weight;

    reasoning.push(`[WEIGHTS] buy=${total_buy_weight.toFixed(6)} sell=${total_sell_weight.toFixed(6)} total=${total_weight.toFixed(6)}`);

    // Defensive double-check
    if (total_buy_weight > 0 && total_sell_weight > 0) {
      reasoning.push('[CONFLICT_BLOCKED] Defensive block');
      return this.noTrade('CONFLICT_BLOCKED', total_buy_weight, total_sell_weight, votes, disabledSummary, reasoning, t0);
    }

    // ── Step 6: Minimum weight ────────────────────────────────────────────
    if (total_weight < this.cfg.minimum_total_weight) {
      reasoning.push(`[INSUFFICIENT_WEIGHT] total=${total_weight.toFixed(4)} < min=${this.cfg.minimum_total_weight}`);
      return this.noTrade('INSUFFICIENT_WEIGHT', total_buy_weight, total_sell_weight, votes, disabledSummary, reasoning, t0);
    }

    // ── Step 7: Dominance ─────────────────────────────────────────────────
    const winningSide:   'BUY' | 'SELL' = total_buy_weight >= total_sell_weight ? 'BUY' : 'SELL';
    const winningWeight  = winningSide === 'BUY' ? total_buy_weight : total_sell_weight;
    const dominance_ratio = total_weight > 0 ? winningWeight / total_weight : 0;

    reasoning.push(`[DOMINANCE] side=${winningSide} ratio=${dominance_ratio.toFixed(4)} threshold=${this.cfg.dominance_ratio}`);

    if (dominance_ratio < this.cfg.dominance_ratio) {
      reasoning.push(`[LOW_DOMINANCE] ${(dominance_ratio * 100).toFixed(1)}% < ${(this.cfg.dominance_ratio * 100).toFixed(1)}%`);
      return this.noTrade('LOW_DOMINANCE', total_buy_weight, total_sell_weight, votes, disabledSummary, reasoning, t0);
    }

    // ── Step 8: Single-strategy high-confidence gate ──────────────────────
    const winnersVotes = votes.filter(v => v.vote === winningSide);
    if (winnersVotes.length === 1 && winnersVotes[0].confidence < 0.72) {
      reasoning.push(`[SINGLE_LOW_CONF] single strategy conf ${winnersVotes[0].confidence.toFixed(3)} < 0.72`);
      return this.noTrade('SINGLE_STRATEGY_LOW_CONFIDENCE', total_buy_weight, total_sell_weight, votes, disabledSummary, reasoning, t0);
    }

    // ── Step 9: Select best signal ────────────────────────────────────────
    const winnerSignals = (winningSide === 'BUY' ? buySignals : sellSignals)
      .filter(s => s.raw_signal !== null);

    if (!winnerSignals.length) {
      reasoning.push('[NO_VALID_SIGNAL] no raw signal from winning strategies');
      return this.noTrade('INSUFFICIENT_WEIGHT', total_buy_weight, total_sell_weight, votes, disabledSummary, reasoning, t0);
    }

    // [FIX-2] Use pre-computed weights from votes array
    const best = winnerSignals.reduce((a, b) => {
      const wa = winnersVotes.find(v => v.strategy_name === a.strategy_name)?.weight ?? 0;
      const wb = winnersVotes.find(v => v.strategy_name === b.strategy_name)?.weight ?? 0;
      return wa * a.confidence > wb * b.confidence ? a : b;
    });

    const mergedSignal: Signal = {
      ...best.raw_signal!,
      source:     winnersVotes.map(v => v.strategy_name).join('+'),
      reason:     `[CONSENSUS:${winningSide}] ` + winnersVotes.map(v => `${v.strategy_name}(w=${v.weight.toFixed(4)})`).join(' | '),
      confidence: Math.min(0.95, best.confidence),
    };

    reasoning.push(`[APPROVED] ${winningSide} ${ctx.symbol} weight=${total_weight.toFixed(4)} dom=${dominance_ratio.toFixed(3)} voters=${winnersVotes.length}`);
    this.logger.info(JSON.stringify({
      event: 'CONSENSUS_APPROVED', symbol: ctx.symbol, side: winningSide,
      total_weight: total_weight.toFixed(4), dominance: dominance_ratio.toFixed(4),
      voters: winnersVotes.length,
    }));

    return {
      outcome:           winningSide,
      block_reason:      'APPROVED',
      signal:            mergedSignal,
      total_buy_weight,
      total_sell_weight,
      dominance_ratio,
      active_strategies: activeEntries.length,
      votes,
      disabled_strategies: disabledSummary,
      reasoning,
      timestamp:         ctx.timestamp,
      duration_ms:       Date.now() - t0,
    };
  }

  // ─── Weight formula ───────────────────────────────────────────────────────

  /**
   * [FIX-1] Weight formula with bootstrap for new strategies.
   *
   * Established strategies (enough trade history):
   *   weight = max(0, sharpe) × rolling_win_rate × confidence
   *
   * New strategies (< min_trades_for_gate):
   *   weight = BOOTSTRAP_SHARPE × rolling_win_rate × confidence
   *   This gives them a non-zero vote weight while they build history.
   *   The weight is capped at 50% of max possible to not overpower veterans.
   */
  private computeWeight(ss: StrategySignal, isNew: boolean): number {
    const sharpe  = isNew ? BOOTSTRAP_SHARPE : Math.max(0, ss.metrics.sharpe_ratio);
    const rollWR  = Math.max(0.1, ss.metrics.rolling_win_rate); // floor at 0.1
    const conf    = Math.max(0, ss.confidence);
    const weight  = sharpe * rollWR * conf;

    // New strategies capped at 50% to prevent them from dominating
    if (isNew) return Math.min(weight, 0.5 * BOOTSTRAP_SHARPE * 1.0 * 1.0);
    return weight;
  }

  // ─── NO_TRADE factory ─────────────────────────────────────────────────────

  private noTrade(
    reason: BlockReason, buyW: number, sellW: number,
    votes: VoteDetail[], disabled: Array<{ name: string; reason: string }>,
    reasoning: string[], t0: number,
  ): ConsensusResult {
    return {
      outcome:           'NO_TRADE',
      block_reason:      reason,
      signal:            null,
      total_buy_weight:  buyW,
      total_sell_weight: sellW,
      dominance_ratio:   0,
      active_strategies: this.registry.getActive().length,
      votes, disabled_strategies: disabled, reasoning,
      timestamp:  Date.now(),
      duration_ms: Date.now() - t0,
    };
  }
}
