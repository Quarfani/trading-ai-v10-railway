/**
 * ATR UTILITIES — v7.1
 * [FIX] dynamicTakeProfit: يجتنب القمم/القيعان القريبة في طريق الـ TP
 * [NEW] minimumRR: يضمن أن الـ TP لا يُجبر R:R على الهبوط تحت 1.5
 * [NEW] structureStop: يستخدم آخر High/Low pivot كـ SL بدلاً من ATR ثابت
 */
import { Candle, Side } from '../types/trading.types';

// ─── Core ATR calculation ─────────────────────────────────────────────────────

export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 0;
  const slice = candles.slice(-Math.min(candles.length, period * 3));

  // True Range for each bar
  const trs: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    trs.push(Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low  - slice[i - 1].close),
    ));
  }

  // Wilder smoothing (EMA with α = 1/period)
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ─── Stop Loss ────────────────────────────────────────────────────────────────

export function atrStopLoss(side: Side, price: number, atr: number, mult = 1.5): number {
  return side === 'BUY' ? price - atr * mult : price + atr * mult;
}

/** Structure-based stop: behind last significant swing high/low */
export function structureStopLoss(
  side: Side, candles: Candle[], atr: number, lookback = 20, buffer = 0.3,
): number {
  const slice = candles.slice(-Math.min(candles.length, lookback));
  if (side === 'BUY') {
    const swingLow = Math.min(...slice.map(c => c.low));
    return swingLow - atr * buffer;
  }
  const swingHigh = Math.max(...slice.map(c => c.high));
  return swingHigh + atr * buffer;
}

// ─── Take Profit ─────────────────────────────────────────────────────────────

export function atrTakeProfit(side: Side, price: number, atr: number, mult = 3.0): number {
  return side === 'BUY' ? price + atr * mult : price - atr * mult;
}

/**
 * Dynamic TP that:
 * 1. Starts at price ± ATR × mult
 * 2. Pulls back to just before the nearest significant S/R in path
 * 3. Ensures final R:R ≥ minRR (defaults to 1.5)
 *
 * [FIX] was just returning raw ATR × mult with no S/R avoidance
 */
export function dynamicTakeProfit(
  side:    Side,
  entry:   number,
  atr:     number,
  mult:    number,
  candles: Candle[],
  sl?:     number,      // [NEW] for minRR enforcement
  minRR  = 1.5,
): number {
  const rawTP = side === 'BUY' ? entry + atr * mult : entry - atr * mult;

  // Find S/R levels from last 50 bars
  const slice = candles.slice(-50);

  // Collect pivot highs/lows
  const pivotHighs: number[] = [];
  const pivotLows:  number[] = [];

  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    const isHigh = c.high > slice[i-1].high && c.high > slice[i-2].high &&
                   c.high > slice[i+1].high && c.high > slice[i+2].high;
    const isLow  = c.low  < slice[i-1].low  && c.low  < slice[i-2].low  &&
                   c.low  < slice[i+1].low   && c.low  < slice[i+2].low;
    if (isHigh) pivotHighs.push(c.high);
    if (isLow)  pivotLows.push(c.low);
  }

  let finalTP = rawTP;

  if (side === 'BUY') {
    // Find nearest resistance between entry and rawTP
    const resistances = pivotHighs.filter(h => h > entry + atr * 0.3 && h < rawTP);
    if (resistances.length > 0) {
      const nearest = Math.min(...resistances);
      // Pull back TP to just before the resistance (0.2 × ATR buffer)
      finalTP = nearest - atr * 0.2;
    }
  } else {
    // Find nearest support between entry and rawTP
    const supports = pivotLows.filter(l => l < entry - atr * 0.3 && l > rawTP);
    if (supports.length > 0) {
      const nearest = Math.max(...supports);
      finalTP = nearest + atr * 0.2;
    }
  }

  // [NEW] Enforce minimum R:R
  if (sl !== undefined) {
    const slDist = Math.abs(entry - sl);
    const minTP  = side === 'BUY'
      ? entry + slDist * minRR
      : entry - slDist * minRR;
    finalTP = side === 'BUY'
      ? Math.max(finalTP, minTP)
      : Math.min(finalTP, minTP);
  }

  // Safety: TP must be on correct side of entry
  if (side === 'BUY'  && finalTP <= entry) finalTP = rawTP;
  if (side === 'SELL' && finalTP >= entry) finalTP = rawTP;

  return finalTP;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Round to symbol precision */
export function roundToTick(value: number, tick: number): number {
  return Math.round(value / tick) * tick;
}

/** ATR as percentage of price */
export function atrPercent(candles: Candle[], period = 14): number {
  const last = candles[candles.length - 1];
  const atr  = calculateATR(candles, period);
  return last.close > 0 ? atr / last.close : 0;
}
