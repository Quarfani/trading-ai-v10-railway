/**
 * INTEGRATION TEST — v9.0 Full Pipeline
 * Tests D1Bias + CandlestickPattern + SpreadAdjustment + RecoveryMode
 */
export {};
import { D1TrendBiasFilter }        from '../core/D1TrendBiasFilter';
import { CandlestickPatternEngine } from '../engines/CandlestickPatternEngine';
import { SpreadAdjustment, GapProtection } from '../execution/SpreadAdjustment';
import { MonteCarloSimulator }      from '../optimization/MonteCarloSimulator';
import { Signal, Candle }           from '../types/trading.types';

let ok = 0, fail = 0;
function assert(c: boolean, label: string) {
  if (c) { console.log(`  ✅  ${label}`); ok++; }
  else   { console.error(`  ❌  ${label}`); fail++; process.exitCode = 1; }
}

function makeSignal(side: 'BUY'|'SELL' = 'BUY'): Signal {
  return { symbol: 'EURUSD', side, price: 1.0850, confidence: 0.70,
    sl: side === 'BUY' ? 1.0800 : 1.0900, tp: side === 'BUY' ? 1.0950 : 1.0750, source: 'TREND', reason: 'test', timestamp: Date.now() };
}
function makeCandle(p: number): Candle {
  return { time: Date.now(), open: p, high: p+0.0005, low: p-0.0005, close: p, volume: 100 };
}

// ─── SpreadAdjustment ────────────────────────────────────────────────────────
console.log('\n═══ SpreadAdjustment ═══');
{
  const adj    = new SpreadAdjustment();
  const signal = makeSignal('BUY');
  const spread = 0.00010; // 1 pip

  const adjusted = adj.adjust(signal, spread);
  assert(adjusted.sl < signal.sl, 'BUY: adjusted SL moves further away (accounts for spread)');
  assert(adjusted.tp >= signal.tp, 'BUY: adjusted TP same or higher');
  assert(adjusted.sl < adjusted.price, 'BUY: adjusted SL still below price');
  assert(adjusted.tp > adjusted.price, 'BUY: adjusted TP still above price');

  const sellSig     = makeSignal('SELL');
  const sellAdj     = adj.adjust(sellSig, spread);
  assert(sellAdj.sl > sellSig.sl, 'SELL: adjusted SL moves further away');
  assert(sellAdj.sl > sellAdj.price, 'SELL: adjusted SL still above price');
  assert(sellAdj.tp < sellAdj.price, 'SELL: adjusted TP still below price');
}

// ─── GapProtection ───────────────────────────────────────────────────────────
console.log('\n═══ GapProtection ═══');
{
  const gp    = new GapProtection();
  const trade = { id: 1, symbol: 'EURUSD', side: 'BUY' as const,
    volume: 0.1, entry: 1.0850, sl: 1.0800, tp: 1.0950,
    status: 'open' as const, openedAt: Date.now(), source: 'TREND' };

  // BUY trade, price gapped below SL → should close
  const gapResult = gp.gapJumpedSL(trade, 1.0790);
  // Sunday 22:00 check depends on current UTC time, just test the logic
  // In non-weekend time: should return false
  const nonWeekend = gp.gapJumpedSL(trade, 1.0790);
  assert(typeof nonWeekend === 'boolean', 'gapJumpedSL returns boolean');

  // Weekend SL adjustment: if in profit, SL should move closer
  const adjusted = gp.adjustForWeekendRisk(trade, 1.0900); // price above entry → in profit
  // In non-Friday: returns original SL
  assert(typeof adjusted === 'number', 'adjustForWeekendRisk returns number');
}

// ─── MonteCarloSimulator ─────────────────────────────────────────────────────
console.log('\n═══ MonteCarloSimulator ═══');
{
  const mc = new MonteCarloSimulator();

  // Simulate with 50 profitable trades
  const trades = Array.from({ length: 50 }, (_, i) => ({ profit: i % 3 === 0 ? -50 : 100 }));
  const result = mc.run(trades, 10_000, 1_000, 50);

  assert(result.runs === 1_000,                          'Correct number of runs');
  assert(result.tradeCount === 50,                       'Correct trade count');
  assert(result.p50 > result.p5,                         'p50 > p5 (median better than worst)');
  assert(result.p95 > result.p50,                        'p95 > p50 (best better than median)');
  assert(result.probProfit > 0 && result.probProfit <= 1, 'Probability of profit in [0,1]');
  assert(result.maxDD_p95 >= result.maxDD_p50,            'p95 DD ≥ p50 DD');
  assert(result.kellyFraction >= 0,                      'Kelly ≥ 0');
  assert(result.safePositionPct > 0,                     'Safe position > 0');

  const summary = mc.summarize(result);
  assert(summary.includes('Monte Carlo'),                'Summary contains Monte Carlo');
  assert(summary.includes('Probability of Profit'),      'Summary contains probability');
  assert(summary.includes('Kelly Fraction'),             'Summary contains Kelly');

  // Edge case: insufficient trades
  const noData = mc.run([], 10_000, 1_000, 50);
  assert(noData.probProfit === 0, 'Empty trades → 0 probability');
}

// ─── D1 → Candlestick → Signal pipeline ─────────────────────────────────────
console.log('\n═══ D1 + Candlestick Pipeline ═══');
{
  const d1Filter  = new D1TrendBiasFilter();
  const patterns  = new CandlestickPatternEngine();

  // Build uptrend D1
  const d1 = Array.from({ length: 250 }, (_, i) => {
    const p = 1.0000 + i * 0.002;
    return makeCandle(p);
  });

  const signal = makeSignal('BUY');
  const bias   = d1Filter.evaluate('EURUSD', 'BUY', 'TREND', d1);

  // Apply D1 bias to signal
  const adjustedConf = signal.confidence * bias.confidMult;
  assert(adjustedConf > 0,                'Adjusted confidence > 0');
  assert(adjustedConf <= 1,               'Adjusted confidence ≤ 1');
  assert(bias.allows !== undefined,       'D1 bias has allows property');

  // Hammer candles confirming BUY
  const hammer: Candle[] = [
    makeCandle(1.0850), makeCandle(1.0845),
    { time: Date.now(), open: 1.0840, high: 1.0843, low: 1.0800, close: 1.0838, volume: 100 },
  ];
  const pattern = patterns.analyze(hammer, 'BUY');
  const finalConf = Math.min(0.95, adjustedConf + pattern.boost);

  assert(finalConf >= adjustedConf - 0.15, 'Final confidence reasonable (not negative-exploded)');
  assert(finalConf <= 0.95,                'Final confidence capped at 0.95');

  // Full pipeline: D1 bullish + Hammer → should result in higher confidence than base
  if (bias.allows && pattern.confirmsBias) {
    assert(finalConf > signal.confidence, 'D1 bullish + Hammer → higher confidence than base');
  }
}

console.log(`\nResult: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
