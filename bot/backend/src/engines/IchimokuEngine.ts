/**
 * ICHIMOKU CLOUD ENGINE
 * ══════════════════════════════════════════════════════════════════════════
 * يستخدم نظام Ichimoku Kinko Hyo الكامل لتحديد الاتجاه ونقاط الدخول:
 *
 * المكونات:
 *   Tenkan-sen  (9)  : خط التحويل — يمثل الزخم قصير المدى
 *   Kijun-sen   (26) : خط القاعدة — يمثل الاتجاه متوسط المدى
 *   Senkou A         : حد السحابة الأمامي A
 *   Senkou B    (52) : حد السحابة الأمامي B
 *   Chikou          : خط التأخر (السعر مؤخراً 26 شمعة)
 *
 * شروط الدخول BUY:
 *   1. السعر فوق السحابة (Kumo)
 *   2. Tenkan فوق Kijun (TK Cross)
 *   3. Senkou A > Senkou B (سحابة خضراء)
 *   4. Chikou فوق السعر قبل 26 شمعة
 *
 * شروط الدخول SELL (عكس الأعلى):
 *   1. السعر تحت السحابة
 *   2. Tenkan تحت Kijun
 *   3. Senkou A < Senkou B (سحابة حمراء)
 *   4. Chikou تحت السعر قبل 26 شمعة
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Signal } from '../types/trading.types';
import { calculateATR, dynamicTakeProfit } from '../utils/ATR';
import { getSymbolSpec } from '../config/symbolConfig';

interface IchimokuValues {
  tenkan:   number;
  kijun:    number;
  senkouA:  number;
  senkouB:  number;
  chikou:   number;
  cloudTop: number;
  cloudBot: number;
}

export class IchimokuEngine {
  readonly name = 'ICHIMOKU';

  analyze(symbol: string, candles: Candle[]): Signal | null {
    // Need at least 52 + 26 = 78 candles minimum (cloud projects forward 26)
    if (candles.length < 110) return null;

    const ich = this.compute(candles);
    if (!ich) return null;

    const last   = candles[candles.length - 1];
    const price  = last.close;
    const atr    = calculateATR(candles.slice(-50), 14) || price * 0.005;

    const aboveCloud  = price > ich.cloudTop;
    const belowCloud  = price < ich.cloudBot;
    const bullishKumo = ich.senkouA > ich.senkouB; // green cloud
    const bearishKumo = ich.senkouA < ich.senkouB; // red cloud
    const tkBullish   = ich.tenkan > ich.kijun;
    const tkBearish   = ich.tenkan < ich.kijun;
    const chikouBull  = ich.chikou > 0;  // chikou > price 26 bars ago
    const chikouBear  = ich.chikou < 0;

    // ── Full Bullish Signal (all 4 conditions met) ──────────────────
    if (aboveCloud && tkBullish && bullishKumo && chikouBull) {
      const distAboveCloud = (price - ich.cloudTop) / atr;
      // Don't enter if price is too far above cloud (overextended)
      if (distAboveCloud > 4) return null;

      let confidence = 0.65;
      if (distAboveCloud < 1.0)  confidence += 0.06; // fresh breakout
      if (distAboveCloud < 0.3)  confidence += 0.05; // very fresh
      if (bullishKumo && ich.senkouA - ich.senkouB > atr * 0.5) confidence += 0.05; // strong cloud
      confidence = Math.min(0.88, confidence);

      const spec = getSymbolSpec(symbol);
      const sl   = Math.min(ich.kijun, ich.cloudTop) - atr * 0.3;
      const candidateTp = dynamicTakeProfit('BUY', price, atr, spec.atrMult * spec.tpRatio, candles);
      const tp = this.enforceMinimumRR(symbol, 'BUY', price, sl, candidateTp);

      if (tp === null) return null;

      return {
        symbol, side: 'BUY', price, confidence, sl, tp,
        source:    this.name,
        reason:    `Ichimoku: above cloud | TK bullish | green Kumo | Chikou bullish | cloud dist=${distAboveCloud.toFixed(2)}×ATR`,
        timestamp: Date.now(),
      };
    }

    // ── Full Bearish Signal ─────────────────────────────────────────
    if (belowCloud && tkBearish && bearishKumo && chikouBear) {
      const distBelowCloud = (ich.cloudBot - price) / atr;
      if (distBelowCloud > 4) return null;

      let confidence = 0.65;
      if (distBelowCloud < 1.0) confidence += 0.06;
      if (distBelowCloud < 0.3) confidence += 0.05;
      if (bearishKumo && ich.senkouB - ich.senkouA > atr * 0.5) confidence += 0.05;
      confidence = Math.min(0.88, confidence);

      const spec = getSymbolSpec(symbol);
      const sl   = Math.max(ich.kijun, ich.cloudBot) + atr * 0.3;
      const candidateTp = dynamicTakeProfit('SELL', price, atr, spec.atrMult * spec.tpRatio, candles);
      const tp = this.enforceMinimumRR(symbol, 'SELL', price, sl, candidateTp);

      if (tp === null) return null;

      return {
        symbol, side: 'SELL', price, confidence, sl, tp,
        source:    this.name,
        reason:    `Ichimoku: below cloud | TK bearish | red Kumo | Chikou bearish | cloud dist=${distBelowCloud.toFixed(2)}×ATR`,
        timestamp: Date.now(),
      };
    }

    // ── Partial signals (3 of 4 conditions) — lower confidence ─────
    const bullScore = [aboveCloud, tkBullish, bullishKumo, chikouBull].filter(Boolean).length;
    const bearScore = [belowCloud, tkBearish, bearishKumo, chikouBear].filter(Boolean).length;

    if (bullScore === 3 && aboveCloud && tkBullish) {
      const spec = getSymbolSpec(symbol);
      const sl   = ich.kijun - atr * 0.5;
      const candidateTp = dynamicTakeProfit('BUY', price, atr, spec.atrMult * spec.tpRatio, candles);
      const tp = this.enforceMinimumRR(symbol, 'BUY', price, sl, candidateTp);
      if (tp === null) return null;
      return {
        symbol, side: 'BUY', price, confidence: 0.56, sl, tp,
        source:    this.name,
        reason:    `Ichimoku: 3/4 conditions (partial) BUY`,
        timestamp: Date.now(),
      };
    }

    if (bearScore === 3 && belowCloud && tkBearish) {
      const spec = getSymbolSpec(symbol);
      const sl   = ich.kijun + atr * 0.5;
      const candidateTp = dynamicTakeProfit('SELL', price, atr, spec.atrMult * spec.tpRatio, candles);
      const tp = this.enforceMinimumRR(symbol, 'SELL', price, sl, candidateTp);
      if (tp === null) return null;
      return {
        symbol, side: 'SELL', price, confidence: 0.56, sl, tp,
        source:    this.name,
        reason:    `Ichimoku: 3/4 conditions (partial) SELL`,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  private enforceMinimumRR(
    symbol: string,
    side: 'BUY' | 'SELL',
    price: number,
    sl: number,
    candidateTp: number,
  ): number | null {
    const minRR = 1.5;
    const risk = Math.abs(price - sl);

    if (!(risk > 0) || !Number.isFinite(candidateTp)) {
      return null;
    }

    const reward =
      side === 'BUY'
        ? candidateTp - price
        : price - candidateTp;

    const rr = reward / risk;

    if (!(reward > 0) || rr < minRR) {
      return null;
    }

    return candidateTp;
  }

  private compute(candles: Candle[]): IchimokuValues | null {
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const n      = candles.length;

    const midpoint = (h: number[], l: number[], from: number, period: number): number => {
      const slice = { h: h.slice(from, from + period), l: l.slice(from, from + period) };
      return (Math.max(...slice.h) + Math.min(...slice.l)) / 2;
    };

    // Tenkan-sen (9)
    if (n < 9) return null;
    const tenkan = midpoint(highs, lows, n - 9, 9);

    // Kijun-sen (26)
    if (n < 26) return null;
    const kijun = midpoint(highs, lows, n - 26, 26);

    // Senkou A = (Tenkan + Kijun) / 2 projected 26 forward
    // For current analysis we use the value from 26 bars ago
    if (n < 52) return null;
    const senkouA_val = (
      midpoint(highs, lows, n - 26 - 9, 9) +
      midpoint(highs, lows, n - 26 - 26, 26)
    ) / 2;

    // Senkou B (52) projected 26 forward — use 52 bars from 26 bars ago
    if (n < 78) return null;
    const senkouB_val = midpoint(highs, lows, n - 26 - 52, 52);

    const cloudTop = Math.max(senkouA_val, senkouB_val);
    const cloudBot = Math.min(senkouA_val, senkouB_val);

    // Chikou: current close vs close 26 bars ago (positive = bullish)
    const chikou = closes[n - 1] - closes[n - 26];

    return {
      tenkan, kijun,
      senkouA: senkouA_val,
      senkouB: senkouB_val,
      chikou,
      cloudTop,
      cloudBot,
    };
  }
}
