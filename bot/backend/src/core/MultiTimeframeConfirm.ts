import { EMA, RSI, MACD } from 'technicalindicators';
import { calculateATR } from '../utils/ATR';
import { Candle, Side, Timeframe } from '../types/trading.types';
import { TIMEFRAMES } from '../market/market.types';
import { MarketScanner } from './MarketScanner';
import { Logger } from '../utils/Logger';

export interface MTFResult {
  approved: boolean;
  h1ok: boolean;
  h4ok: boolean;
  checks: Record<string, boolean>;
  requiredTimeframes: Timeframe[];
  reason?: string;
}

const MACD_HIST_THRESHOLD = 0.0005;
const MACD_HIST_ATR_MULT = 0.30;
const TIMEFRAME_INDEX: Record<Timeframe, number> = {
  M1: 0, M5: 1, M15: 2, M30: 3, H1: 4, H4: 5, D1: 6,
};

export function selectConfirmationTimeframes(entry: Timeframe, minimum = 2): Timeframe[] {
  if (!TIMEFRAMES.includes(entry) || minimum <= 0) return [];
  const idx = TIMEFRAME_INDEX[entry];
  const higher = TIMEFRAMES.filter(tf => TIMEFRAME_INDEX[tf] > idx);
  const lower = TIMEFRAMES.filter(tf => TIMEFRAME_INDEX[tf] < idx).reverse();
  return [...higher, ...lower].slice(0, minimum);
}

export class MultiTimeframeConfirm {
  private logger = new Logger('MTF');

  constructor(private scanner: MarketScanner) {}

  async confirm(symbol: string, side: Side, entryTimeframe: Timeframe = 'H1'): Promise<boolean> {
    return (await this.confirmFull(symbol, side, entryTimeframe)).approved;
  }

  async confirmFull(symbol: string, side: Side, entryTimeframe: Timeframe = 'H1'): Promise<MTFResult> {
    const requiredTimeframes = selectConfirmationTimeframes(entryTimeframe, 2);
    if (requiredTimeframes.length < 2) {
      return { approved: false, h1ok: false, h4ok: false, checks: {}, requiredTimeframes, reason: 'At least two confirmation timeframes are required' };
    }

    const fetched = await Promise.all(requiredTimeframes.map(async tf => {
      const candles = await this.scanner.fetchCandles(symbol, tf, 220).catch(() => []);
      return [tf, candles] as const;
    }));

    const checks: Record<string, boolean> = {};
    const reasons: string[] = [];
    for (const pair of fetched) {
      const tf = pair[0];
      const result = this.tfCheck(pair[1], side, tf);
      checks[tf] = result.ok;
      if (!result.ok) reasons.push(tf + ': ' + (result.reason ?? 'confirmation failed'));
    }

    const approved = requiredTimeframes.every(tf => checks[tf] === true);
    return {
      approved,
      h1ok: checks.H1 === true || !requiredTimeframes.includes('H1'),
      h4ok: checks.H4 === true || !requiredTimeframes.includes('H4'),
      checks,
      requiredTimeframes,
      reason: approved ? undefined : reasons.join(' | '),
    };
  }

  private tfCheck(candles: Candle[], side: Side, label: Timeframe): { ok: boolean; reason?: string } {
    if (candles.length < 200) return { ok: false, reason: label + ' requires >=200 valid candles; got ' + candles.length };

    const closes = candles.map(c => c.close);
    if (closes.some(v => !Number.isFinite(v) || v <= 0)) return { ok: false, reason: label + ' contains invalid prices' };

    const e50 = EMA.calculate({ period: 50, values: closes });
    const e200 = EMA.calculate({ period: 200, values: closes });
    const a50 = e50[e50.length - 1];
    const a200 = e200[e200.length - 1];
    if (!Number.isFinite(a50) || !Number.isFinite(a200)) return { ok: false, reason: label + ' EMA calculation unavailable' };

    const emaAligned = side === 'BUY' ? a50 > a200 : a50 < a200;
    if (!emaAligned) return { ok: false, reason: label + ' EMA trend conflict (EMA50 vs EMA200)' };

    try {
      const rsiVals = RSI.calculate({ period: 14, values: closes });
      const rsi = rsiVals[rsiVals.length - 1];
      if (!Number.isFinite(rsi)) return { ok: false, reason: label + ' RSI unavailable' };
      if (side === 'BUY' && rsi > 78) return { ok: false, reason: label + ' RSI ' + rsi.toFixed(0) + ' overbought (>78)' };
      if (side === 'SELL' && rsi < 22) return { ok: false, reason: label + ' RSI ' + rsi.toFixed(0) + ' oversold (<22)' };
    } catch (error) {
      return { ok: false, reason: label + ' RSI calculation failed: ' + (error instanceof Error ? error.message : String(error)) };
    }

    try {
      const macdR = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
      const hist = macdR[macdR.length - 1]?.histogram;
      const atr = calculateATR(candles.slice(-50), 14);
      if (!Number.isFinite(hist) || !Number.isFinite(atr) || atr <= 0) return { ok: false, reason: label + ' MACD/ATR confirmation unavailable' };
      const threshold = Math.max(MACD_HIST_THRESHOLD, atr * MACD_HIST_ATR_MULT);
      const neutral = Math.abs(hist) < threshold;
      if (!neutral && side === 'BUY' && hist < -threshold) return { ok: false, reason: label + ' MACD histogram bearish' };
      if (!neutral && side === 'SELL' && hist > threshold) return { ok: false, reason: label + ' MACD histogram bullish' };
    } catch (error) {
      return { ok: false, reason: label + ' MACD calculation failed: ' + (error instanceof Error ? error.message : String(error)) };
    }

    return { ok: true };
  }
}