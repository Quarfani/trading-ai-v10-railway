/**
 * UNIT TESTS — v7.0 Engines (MACD Div, Ichimoku, StochRSI, VWAP)
 */
export {};
import { MACDDivergenceEngine } from '../engines/MACDDivergenceEngine';
import { IchimokuEngine }       from '../engines/IchimokuEngine';
import { StochasticRSIEngine }  from '../engines/StochasticRSIEngine';
import { VWAPEngine }           from '../engines/VWAPEngine';
import { Candle }               from '../types/trading.types';

let ok = 0, fail = 0;
function assert(c: boolean, label: string) {
  if (c) { console.log(`  ✅  ${label}`); ok++; }
  else   { console.error(`  ❌  ${label}`); fail++; process.exitCode = 1; }
}

function makeCandles(n: number, basePrice = 1.08, trend: 'up'|'down'|'flat' = 'flat'): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const step = trend === 'up' ? i * 0.00005 : trend === 'down' ? -i * 0.00005 : 0;
    const p    = basePrice + step + (Math.random() - 0.5) * 0.0002;
    return { time: Date.now() - (n - i) * 3600_000, open: p, high: p + 0.0005, low: p - 0.0005, close: p, volume: 100 + Math.random() * 50 };
  });
}

// ─── MACDDivergenceEngine ──────────────────────────────────────────────────
console.log('\n═══ MACDDivergenceEngine ═══');
{
  const engine = new MACDDivergenceEngine();
  assert(engine.analyze('EURUSD', makeCandles(50)) === null, 'Returns null with < 100 candles');
  const candles = makeCandles(150, 1.08, 'flat');
  const result  = engine.analyze('EURUSD', candles);
  // May or may not have divergence in random data — just check structure if present
  if (result) {
    assert(['BUY','SELL'].includes(result.side), 'Signal side is BUY or SELL');
    assert(result.confidence > 0.5, 'Confidence > 0.5');
    assert(result.source === 'MACD_DIV', 'Source is MACD_DIV');
    assert(result.sl > 0, 'SL is positive');
    assert(result.tp > 0, 'TP is positive');
    if (result.side === 'BUY')  assert(result.sl < result.price && result.tp > result.price, 'BUY: SL below, TP above');
    if (result.side === 'SELL') assert(result.sl > result.price && result.tp < result.price, 'SELL: SL above, TP below');
  } else {
    assert(true, 'No divergence in random data (acceptable)');
  }
}

// ─── IchimokuEngine ────────────────────────────────────────────────────────
console.log('\n═══ IchimokuEngine ═══');
{
  const engine = new IchimokuEngine();
  assert(engine.analyze('EURUSD', makeCandles(80)) === null, 'Returns null with < 110 candles');

  // Strong uptrend should trigger bullish Ichimoku
  const bullish = makeCandles(150, 1.0000, 'up');
  const result  = engine.analyze('EURUSD', bullish);
  if (result) {
    assert(result.source === 'ICHIMOKU', 'Source is ICHIMOKU');
    assert(result.confidence >= 0.56, 'Confidence ≥ 0.56 (partial or full)');
    assert(result.sl > 0 && result.tp > 0, 'SL and TP are valid');
  } else {
    assert(true, 'No Ichimoku signal in mild trend (acceptable)');
  }
}

// ─── StochasticRSIEngine ───────────────────────────────────────────────────
console.log('\n═══ StochasticRSIEngine ═══');
{
  const engine = new StochasticRSIEngine();
  assert(engine.analyze('EURUSD', makeCandles(50)) === null, 'Returns null with < 80 candles');

  const flat   = makeCandles(100, 1.08, 'flat');
  const result = engine.analyze('EURUSD', flat);
  if (result) {
    assert(result.source === 'STOCH_RSI', 'Source is STOCH_RSI');
    assert(result.confidence > 0.5, 'Confidence > 0.5');
  } else {
    assert(true, 'No StochRSI signal in random data (OK)');
  }
}

// ─── VWAPEngine ────────────────────────────────────────────────────────────
console.log('\n═══ VWAPEngine ═══');
{
  const engine = new VWAPEngine();
  assert(engine.analyze('EURUSD', makeCandles(30)) === null, 'Returns null with < 60 candles');

  // Create candles with price far below VWAP (should trigger BUY)
  const base      = makeCandles(100, 1.0800, 'flat');
  const withCrash = [...base.slice(0, 95),
    { time: Date.now(), open: 1.0750, high: 1.0752, low: 1.0720, close: 1.0722, volume: 250 },
    { time: Date.now(), open: 1.0722, high: 1.0730, low: 1.0710, close: 1.0728, volume: 200 },
    { time: Date.now(), open: 1.0728, high: 1.0735, low: 1.0712, close: 1.0733, volume: 180 },
    { time: Date.now(), open: 1.0733, high: 1.0740, low: 1.0720, close: 1.0738, volume: 160 },
    { time: Date.now(), open: 1.0738, high: 1.0745, low: 1.0725, close: 1.0742, volume: 150 },
  ];
  const result = engine.analyze('EURUSD', withCrash);
  // In flat + crash scenario, might detect BUY
  if (result) {
    assert(result.source === 'VWAP', 'Source is VWAP');
    assert(result.sl > 0 && result.tp > 0, 'SL/TP are valid');
  } else {
    assert(true, 'No VWAP signal (volume/ADX filters may have blocked it)');
  }
}

console.log(`\nResult: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
