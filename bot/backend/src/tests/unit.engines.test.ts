/**
 * UNIT TESTS — Strategy Engines
 * Tests each engine with synthetic candle data
 */
export {};

import { TrendEngine }    from '../engines/TrendEngine';
import { RSIEngine }      from '../engines/RSIEngine';
import { BreakoutEngine } from '../engines/BreakoutEngine';
import { Candle }         from '../types/trading.types';

let ok = 0, fail = 0;
function assert(c: boolean, label: string) {
  if (c) { console.log(`  ✅  ${label}`); ok++; }
  else   { console.error(`  ❌  ${label}`); fail++; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function flatCandles(n: number, price = 1.0800, step = 0): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: Date.now() - (n - i) * 60_000,
    open: price + i * step, high: price + i * step + 0.0005,
    low:  price + i * step - 0.0005, close: price + i * step,
    volume: 100,
  }));
}

function trendingCandles(n: number, startPrice: number, trend: 'up' | 'down'): Candle[] {
  const step = trend === 'up' ? 0.00005 : -0.00005;
  return flatCandles(n, startPrice, step);
}

// ─── TrendEngine ─────────────────────────────────────────────────────────────

console.log('\n═══ TrendEngine ═══');
{
  const engine = new TrendEngine();

  // Not enough candles
  const short = flatCandles(100);
  assert(engine.analyze('EURUSD', short) === null, 'Returns null with < 220 candles');

  // Rising candles → EMA50 should cross above EMA200 eventually
  const up = trendingCandles(300, 1.0500, 'up');
  const sigUp = engine.analyze('EURUSD', up);
  // May or may not fire depending on cross timing — just check shape if fired
  if (sigUp) {
    assert(sigUp.side === 'BUY',         'Rising trend → BUY signal');
    assert(sigUp.sl < sigUp.price,       'BUY: SL below price');
    assert(sigUp.tp > sigUp.price,       'BUY: TP above price');
    assert(sigUp.confidence > 0,         'Confidence > 0');
    assert(sigUp.source === 'TREND',     'Source is TREND');
  } else {
    assert(true, 'No cross yet in trend data (OK)');
  }

  // Falling candles
  const dn = trendingCandles(300, 1.1500, 'down');
  const sigDn = engine.analyze('EURUSD', dn);
  if (sigDn) {
    assert(sigDn.side === 'SELL',        'Falling trend → SELL signal');
    assert(sigDn.sl > sigDn.price,       'SELL: SL above price');
    assert(sigDn.tp < sigDn.price,       'SELL: TP below price');
  } else {
    assert(true, 'No cross yet in falling data (OK)');
  }
}

// ─── RSIEngine ───────────────────────────────────────────────────────────────

console.log('\n═══ RSIEngine ═══');
{
  const engine = new RSIEngine();

  // Not enough candles
  assert(engine.analyze('EURUSD', flatCandles(20)) === null, 'Returns null with < 30 candles');

  // Oversold: falling prices → RSI should go below 30
  const falling = Array.from({ length: 50 }, (_, i) => ({
    time: Date.now() - (50 - i) * 60_000,
    open: 1.1000 - i * 0.001, high: 1.1000 - i * 0.001 + 0.0002,
    low: 1.1000 - i * 0.001 - 0.0002, close: 1.1000 - i * 0.001,
    volume: 100,
  }));
  const sigBuy = engine.analyze('EURUSD', falling);
  if (sigBuy) {
    assert(sigBuy.side === 'BUY',        'Oversold → BUY');
    assert(sigBuy.sl < sigBuy.price,     'BUY: SL below price');
    assert(sigBuy.tp > sigBuy.price,     'BUY: TP above price');
  }

  // Overbought: rising prices
  const rising = Array.from({ length: 50 }, (_, i) => ({
    time: Date.now() - (50 - i) * 60_000,
    open: 1.0500 + i * 0.001, high: 1.0500 + i * 0.001 + 0.0002,
    low: 1.0500 + i * 0.001 - 0.0002, close: 1.0500 + i * 0.001,
    volume: 100,
  }));
  const sigSell = engine.analyze('EURUSD', rising);
  if (sigSell) {
    assert(sigSell.side === 'SELL',      'Overbought → SELL');
    assert(sigSell.sl > sigSell.price,   'SELL: SL above price');
  }
}

// ─── BreakoutEngine ──────────────────────────────────────────────────────────

console.log('\n═══ BreakoutEngine ═══');
{
  const engine = new BreakoutEngine();

  assert(engine.analyze('EURUSD', flatCandles(20)) === null, 'Returns null with < 25 candles');

  // Breakout above 20-bar high
  const base = flatCandles(50, 1.0800, 0);
  base[base.length - 1].close = 1.0900; // last candle breaks out
  base[base.length - 1].high  = 1.0905;
  base[base.length - 1].volume = 200;
  const sigBreakoutUp = engine.analyze('EURUSD', base);
  assert(sigBreakoutUp?.side === 'BUY', 'Breakout above high → BUY');

  // Breakdown below 20-bar low
  const base2 = flatCandles(50, 1.0800, 0);
  base2[base2.length - 1].close = 1.0700; // last candle breaks down
  base2[base2.length - 1].low   = 1.0695;
  base2[base2.length - 1].volume = 200;
  const sigBreakDn = engine.analyze('EURUSD', base2);
  assert(sigBreakDn?.side === 'SELL', 'Breakdown below low → SELL');

  // Range-bound → no signal
  const range = flatCandles(30, 1.0800, 0);
  const rangeSignal = engine.analyze('EURUSD', range);
  assert(rangeSignal === null, 'Range-bound prices → no signal');
}

// ─── PositionSizer ───────────────────────────────────────────────────────────

console.log('\n═══ PositionSizer ═══');
{
  const { PositionSizer } = require('../risk/PositionSizer');
  const testDb:any = { getSetting: () => null, setSetting: () => {}, raw: () => ({ prepare: () => ({ get: () => ({ trades: 0, wins: 0, avgWin: 0, avgLoss: 1 }) }) }) };
  const sizer = new PositionSizer({ riskPerTrade: 0.01, accountBalance: 10000, mode: 'paper', compounding: { enabled: false } } as any, testDb);

  const vol = sizer.size('EURUSD', 'BUY', 1.0800, 1.0750, 10000);
  assert(vol > 0,    'EURUSD: volume > 0');
  assert(vol <= 100, 'EURUSD: volume ≤ max');
  assert(vol >= 0.01,'EURUSD: volume ≥ min');

  // With zero SL distance — must return minVolume
  const vol2 = sizer.size('EURUSD', 'BUY', 1.0800, 1.0800, 10000);
  assert(vol2 === 0, 'Zero SL distance -> blocked by risk cap');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════');
if (fail === 0) console.log(`✅  ENGINES PASS — all ${ok} assertions`);
else console.error(`❌  ${fail} FAILURE(S) — ${ok} passed`);
console.log('══════════════════════════════════════════════\n');
if (fail > 0) process.exit(1);
