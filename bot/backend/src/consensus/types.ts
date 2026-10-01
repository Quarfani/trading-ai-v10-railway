/**
 * CONSENSUS ENGINE — SHARED TYPES
 * ══════════════════════════════════════════════════════════════════════════
 * Type definitions shared across StrategyRegistry, PerformanceGate,
 * and StrategyConsensusEngine.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { Candle, Signal, Side, Timeframe } from '../types/trading.types';

// ─── Strategy signal (output of each strategy) ────────────────────────────

export type StrategySignalType = 'BUY' | 'SELL' | 'NONE';

export interface StrategyMetrics {
  win_rate:            number;   // 0–1 all-time
  sharpe_ratio:        number;   // annualised
  max_drawdown:        number;   // 0–1 (e.g. 0.08 = 8%)
  expectancy:          number;   // USD average per trade
  rolling_win_rate:    number;   // last N trades
  rolling_expectancy:  number;   // last N trades USD avg
  total_trades:        number;
  rolling_trades:      number;
}

export interface StrategySignal {
  signal:        StrategySignalType;
  confidence:    number;           // 0–1
  risk_score:    number;           // 0–1 (higher = riskier signal)
  strategy_name: string;
  raw_signal:    Signal | null;    // underlying Signal for execution
  metrics:       StrategyMetrics;
}

// ─── Strategy interface every engine must implement ───────────────────────

export interface IStrategy {
  readonly name: string;
  generate_signal(ctx: StrategyContext): StrategySignal;
}

export interface StrategyContext {
  symbol:    string;
  timeframe: Timeframe;
  candles:   Candle[];
  h4Candles: Candle[];
  regime:    string;
  timestamp: number;
}

// ─── Registry entry ───────────────────────────────────────────────────────

export interface RegistryEntry {
  strategy:    IStrategy;
  enabled:     boolean;
  definition?: import('./strategyDefinition').StrategyDefinition;
  disabledAt?: number;
  disableReason?: string;
  metrics:     StrategyMetrics;
  tradeWindow: TradeRecord[];  // rolling window for metrics calculation
}

export interface TradeRecord {
  profit:     number;
  timestamp:  number;
  win:        boolean;
  entryPrice: number;
  exitPrice:  number;
}

// ─── Consensus result (output of StrategyConsensusEngine) ─────────────────

export type ConsensusOutcome = 'BUY' | 'SELL' | 'NO_TRADE';
export type BlockReason =
  | 'CONFLICT_BLOCKED'
  | 'INSUFFICIENT_WEIGHT'
  | 'LOW_DOMINANCE'
  | 'NO_ACTIVE_STRATEGIES'
  | 'SINGLE_STRATEGY_LOW_CONFIDENCE'
  | 'PERFORMANCE_GATE_FAILED'
  | 'APPROVED';

export interface VoteDetail {
  strategy_name: string;
  vote:          StrategySignalType;
  confidence:    number;
  weight:        number;
  metrics:       StrategyMetrics;
}

export interface ConsensusResult {
  outcome:           ConsensusOutcome;
  block_reason:      BlockReason;
  signal:            Signal | null;    // null when NO_TRADE
  total_buy_weight:  number;
  total_sell_weight: number;
  dominance_ratio:   number;
  active_strategies: number;
  votes:             VoteDetail[];
  disabled_strategies: Array<{ name: string; reason: string }>;
  reasoning:         string[];        // structured log lines
  timestamp:         number;
  duration_ms:       number;
}

// ─── Consensus configuration ──────────────────────────────────────────────

export interface ConsensusConfig {
  minimum_total_weight:     number;  // min combined weight to trade (default 0.3)
  dominance_ratio:          number;  // winning side / total must exceed this (default 0.65)
  minimum_active_strategies: number; // at least N enabled strategies needed (default 1)
  rolling_window_size:      number;  // trades for rolling metrics (default 30)

  // Performance gate thresholds
  gate: {
    min_win_rate:          number;  // default 0.50
    min_sharpe_ratio:      number;  // default 1.0
    min_rolling_expectancy: number; // default 0 (must be positive)
    max_drawdown:          number;  // default 0.20
    min_trades_for_gate:   number;  // trades needed before gate activates (default 15)
  };
}

export const DEFAULT_CONSENSUS_CONFIG: ConsensusConfig = {
  minimum_total_weight:      0.30,
  dominance_ratio:           0.65,
  minimum_active_strategies: 1,
  rolling_window_size:       30,
  gate: {
    min_win_rate:           0.50,
    min_sharpe_ratio:       1.00,
    min_rolling_expectancy: 0.00,
    max_drawdown:           0.20,
    min_trades_for_gate:    15,
  },
};

// ─── Default empty metrics (used by adapters before metrics are computed) ────
export const EMPTY_METRICS_DEFAULT: StrategyMetrics = {
  win_rate: 0.50, sharpe_ratio: 0, max_drawdown: 0,
  expectancy: 0, rolling_win_rate: 0.50, rolling_expectancy: 0,
  total_trades: 0, rolling_trades: 0,
};
