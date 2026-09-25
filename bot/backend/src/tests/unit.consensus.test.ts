/**
 * CONSENSUS ENGINE — UNIT TESTS
 * Tests for: StrategyRegistry, PerformanceGate, StrategyConsensusEngine
 */
import { StrategyRegistry }        from '../consensus/StrategyRegistry';
import { PerformanceGate }         from '../consensus/PerformanceGate';
import { StrategyConsensusEngine } from '../consensus/StrategyConsensusEngine';
import {
  IStrategy, StrategySignal, StrategyContext,
  DEFAULT_CONSENSUS_CONFIG, EMPTY_METRICS_DEFAULT,
} from '../consensus/types';

// ─── Mock DB ─────────────────────────────────────────────────────────────────
const mockDb = {
  raw: () => ({
    prepare: () => ({
      run:  () => {},
      get:  () => null,
      all:  () => [],
    }),
  }),
  getSetting: () => null,
} as any;

// ─── Mock strategies ─────────────────────────────────────────────────────────
function mockStrategy(name: string, vote: 'BUY'|'SELL'|'NONE', conf = 0.80): IStrategy {
  return {
    name,
    generate_signal: (_ctx: StrategyContext): StrategySignal => ({
      signal: vote, confidence: conf, risk_score: 0.2,
      strategy_name: name, raw_signal: vote === 'NONE' ? null : {
        symbol: 'EURUSD', side: vote as any, price: 1.2, confidence: conf,
        sl: 1.19, tp: 1.22, source: name, reason: 'test', timestamp: Date.now(),
      },
      metrics: { ...EMPTY_METRICS_DEFAULT, sharpe_ratio: 1.5, rolling_win_rate: 0.60, win_rate: 0.55 },
    }),
  };
}

const testCtx: StrategyContext = {
  symbol: 'EURUSD', candles: [], h4Candles: [], regime: 'TRENDING', timestamp: Date.now(),
};

// ─── StrategyRegistry ─────────────────────────────────────────────────────────
describe('StrategyRegistry', () => {
  test('registers strategy correctly', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY'));
    expect(reg.getActive()).toHaveLength(1);
    expect(reg.getActive()[0].strategy.name).toBe('TREND');
  });

  test('does not double-register', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY'));
    reg.register(mockStrategy('TREND', 'BUY'));
    expect(reg.getActive()).toHaveLength(1);
  });

  test('enable/disable works', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY'));
    reg.disable('TREND', 'test');
    expect(reg.getActive()).toHaveLength(0);
    expect(reg.getDisabled()).toHaveLength(1);
    reg.enable('TREND', 'test');
    expect(reg.getActive()).toHaveLength(1);
  });

  test('recordTrade updates metrics', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY'));
    for (let i = 0; i < 20; i++) {
      reg.recordTrade('TREND', i % 3 === 0 ? -50 : 100, 1.2, i % 3 === 0 ? 1.19 : 1.22);
    }
    const m = reg.getMetrics('TREND');
    expect(m).not.toBeNull();
    expect(m!.total_trades).toBe(20);
    expect(m!.win_rate).toBeGreaterThan(0);
  });
});

// ─── PerformanceGate ──────────────────────────────────────────────────────────
describe('PerformanceGate', () => {
  test('passes strategy with insufficient trades (below gate threshold)', () => {
    const reg  = new StrategyRegistry(mockDb, { gate: { ...DEFAULT_CONSENSUS_CONFIG.gate, min_trades_for_gate: 15 } });
    const gate = new PerformanceGate(reg, DEFAULT_CONSENSUS_CONFIG);
    reg.register(mockStrategy('TREND', 'BUY'));
    const result = gate.evaluate();
    expect(result.skipped).toContain('TREND');
    expect(result.disabled).toHaveLength(0);
  });

  test('disables strategy with bad sharpe after enough trades', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY'));
    // Manually set bad metrics
    const entry = (reg.getAll().get('TREND'))!;
    entry.metrics.sharpe_ratio = -0.5;
    entry.metrics.total_trades = 20;

    const gate   = new PerformanceGate(reg, DEFAULT_CONSENSUS_CONFIG);
    const result = gate.evaluate();
    expect(result.disabled.some(d => d.strategy === 'TREND')).toBe(true);
    expect(reg.getActive().some(e => e.strategy.name === 'TREND')).toBe(false);
  });
});

// ─── StrategyConsensusEngine ──────────────────────────────────────────────────
describe('StrategyConsensusEngine', () => {
  test('approves when all strategies agree BUY', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND',     'BUY', 0.80));
    reg.register(mockStrategy('STRUCTURE', 'BUY', 0.75));
    // Give both enough trades so weight is non-zero
    for (const name of ['TREND','STRUCTURE']) {
      const e = reg.getAll().get(name)!;
      e.metrics = { ...EMPTY_METRICS_DEFAULT, sharpe_ratio: 1.5, rolling_win_rate: 0.60, rolling_expectancy: 1, win_rate: 0.55, total_trades: 20, rolling_trades: 20 };
    }
    const eng = new StrategyConsensusEngine(reg, { minimum_total_weight: 0.05, dominance_ratio: 0.6 });
    const r   = eng.run(testCtx);
    expect(r.outcome).toBe('BUY');
    expect(r.block_reason).toBe('APPROVED');
    expect(r.signal).not.toBeNull();
  });

  test('CONFLICT_BLOCKED when BUY + SELL present', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY',  0.80));
    reg.register(mockStrategy('RSI',   'SELL', 0.75));
    for (const name of ['TREND','RSI']) {
      const e = reg.getAll().get(name)!;
      e.metrics = { ...EMPTY_METRICS_DEFAULT, sharpe_ratio: 1.5, rolling_win_rate: 0.60, rolling_expectancy: 1, win_rate: 0.55, total_trades: 20, rolling_trades: 20 };
    }
    const eng = new StrategyConsensusEngine(reg);
    const r   = eng.run(testCtx);
    expect(r.outcome).toBe('NO_TRADE');
    expect(r.block_reason).toBe('CONFLICT_BLOCKED');
    expect(r.signal).toBeNull();
  });

  test('NO_TRADE when no active strategies', () => {
    const reg = new StrategyRegistry(mockDb);
    const eng = new StrategyConsensusEngine(reg);
    const r   = eng.run(testCtx);
    expect(r.outcome).toBe('NO_TRADE');
    expect(r.block_reason).toBe('NO_ACTIVE_STRATEGIES');
  });

  test('NO_TRADE when weight below minimum', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY', 0.20));
    // sharpe=0 → weight=0
    const e = reg.getAll().get('TREND')!;
    e.metrics = { ...EMPTY_METRICS_DEFAULT, sharpe_ratio: 0, rolling_win_rate: 0.5, win_rate: 0.5, total_trades: 0, rolling_trades: 0 };
    const eng = new StrategyConsensusEngine(reg, { minimum_total_weight: 0.10 });
    const r   = eng.run(testCtx);
    expect(r.outcome).toBe('NO_TRADE');
    expect(r.block_reason).toBe('INSUFFICIENT_WEIGHT');
  });

  test('NO_TRADE for single strategy with low confidence', () => {
    const reg = new StrategyRegistry(mockDb);
    reg.register(mockStrategy('TREND', 'BUY', 0.60)); // below 0.72 threshold
    const e = reg.getAll().get('TREND')!;
    e.metrics = { ...EMPTY_METRICS_DEFAULT, sharpe_ratio: 1.5, rolling_win_rate: 0.60, rolling_expectancy: 1, win_rate: 0.55, total_trades: 20, rolling_trades: 20 };
    const eng = new StrategyConsensusEngine(reg, { minimum_total_weight: 0.01, dominance_ratio: 0.5 });
    const r   = eng.run(testCtx);
    expect(r.outcome).toBe('NO_TRADE');
    expect(r.block_reason).toBe('SINGLE_STRATEGY_LOW_CONFIDENCE');
  });

  test('reasoning array is non-empty and structured', () => {
    const reg = new StrategyRegistry(mockDb);
    const eng = new StrategyConsensusEngine(reg);
    const r   = eng.run(testCtx);
    expect(r.reasoning.length).toBeGreaterThan(0);
    expect(typeof r.reasoning[0]).toBe('string');
  });

  test('duration_ms is measured', () => {
    const reg = new StrategyRegistry(mockDb);
    const eng = new StrategyConsensusEngine(reg);
    const r   = eng.run(testCtx);
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
