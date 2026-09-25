/**
 * SIGNAL QUALITY SCORER
 * ══════════════════════════════════════════════════════════════════════════
 * يعطي كل إشارة درجة جودة شاملة (0–100) بناءً على عوامل متعددة:
 *
 *  1. قوة الاتجاه    — ADX + EMA alignment
 *  2. تقاطع الأطر    — كم timeframe يتفق مع الإشارة
 *  3. حجم التداول    — هل هناك مشاركة حقيقية
 *  4. توقيت الجلسة   — London/NY overlap الأفضل
 *  5. سجل المصدر     — win rate تاريخي لهذا المحرك على هذا الرمز
 *  6. نظام السوق     — هل الاستراتيجية مناسبة للـ regime الحالي
 *  7. نسبة المكافأة/المخاطرة — R:R ratio
 *
 * الدرجة تُستخدم في:
 *   - DecisionEngine: boost/penalize confidence
 *   - PositionSizer: scale volume بناءً على الجودة
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Signal } from '../types/trading.types';
import { MarketRegime }   from './MarketRegimeDetector';
import { Logger }         from '../utils/Logger';

export interface QualityScore {
  total:        number;     // 0–100 final score
  grade:        'A' | 'B' | 'C' | 'D' | 'F';
  components: {
    trendStrength:   number;  // 0–20
    sessionTiming:   number;  // 0–15
    volumeConfirm:   number;  // 0–15
    regimeFit:       number;  // 0–20
    rewardRisk:      number;  // 0–15
    sourceHistory:   number;  // 0–15
  };
  reasons: string[];
  volumeMultiplier: number;   // 0.5–1.2 — scale position size
}

// Trading session windows (UTC hours)
const SESSIONS = {
  TOKYO:       { start: 0,  end: 9  },
  LONDON:      { start: 8,  end: 17 },
  NEWYORK:     { start: 13, end: 22 },
  OVERLAP_LDN_NY: { start: 13, end: 17 }, // BEST session
};

export class SignalQualityScorer {
  private logger = new Logger('QualityScorer');

  /**
   * Score a signal comprehensively.
   * @param signal       The merged signal
   * @param candles      Current timeframe candles
   * @param regime       Detected market regime
   * @param sourceWinRate Historical win rate for this signal's source (0–1)
   */
  score(
    signal:         Signal,
    candles:        Candle[],
    regime:         MarketRegime,
    sourceWinRate = 0.50,
  ): QualityScore {
    const reasons: string[] = [];
    const c: QualityScore['components'] = {
      trendStrength: 0, sessionTiming: 0, volumeConfirm: 0,
      regimeFit: 0, rewardRisk: 0, sourceHistory: 0,
    };

    // ── 1. Trend Strength (0–20) ─────────────────────────────────────────
    c.trendStrength = this.scoreTrendStrength(signal, candles, reasons);

    // ── 2. Session Timing (0–15) ─────────────────────────────────────────
    c.sessionTiming = this.scoreSessionTiming(signal.timestamp, reasons);

    // ── 3. Volume Confirmation (0–15) ────────────────────────────────────
    c.volumeConfirm = this.scoreVolumeConfirmation(candles, reasons);

    // ── 4. Regime Fit (0–20) ─────────────────────────────────────────────
    c.regimeFit = this.scoreRegimeFit(signal.source, regime, reasons);

    // ── 5. Reward/Risk Ratio (0–15) ──────────────────────────────────────
    c.rewardRisk = this.scoreRewardRisk(signal, reasons);

    // ── 6. Source History (0–15) ─────────────────────────────────────────
    c.sourceHistory = this.scoreSourceHistory(sourceWinRate, reasons);

    // ── Total ─────────────────────────────────────────────────────────────
    const total = Math.round(
      c.trendStrength + c.sessionTiming + c.volumeConfirm +
      c.regimeFit + c.rewardRisk + c.sourceHistory
    );

    const grade = total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : total >= 35 ? 'D' : 'F';

    // ── Volume multiplier ─────────────────────────────────────────────────
    const volumeMultiplier = this.computeVolumeMultiplier(total, grade);

    this.logger.debug(
      `[${signal.symbol}] Quality=${total}/100 (${grade}) ` +
      `Trend=${c.trendStrength} Sess=${c.sessionTiming} Vol=${c.volumeConfirm} ` +
      `Regime=${c.regimeFit} RR=${c.rewardRisk} Src=${c.sourceHistory}`
    );

    return { total, grade, components: c, reasons, volumeMultiplier };
  }

  // ─── Component scorers ────────────────────────────────────────────────────

  private scoreTrendStrength(signal: Signal, candles: Candle[], reasons: string[]): number {
    if (candles.length < 50) { reasons.push('⚠ Not enough candles for trend analysis'); return 8; }

    const closes = candles.map(c => c.close);
    const last   = closes[closes.length - 1];

    // Use simple EMA-based trend measure (fast)
    const ema20  = this.ema(closes, 20);
    const ema50  = this.ema(closes, 50);

    const trendAligned = signal.side === 'BUY'
      ? ema20 > ema50 && last > ema20
      : ema20 < ema50 && last < ema20;

    const priceFromEMA50Pct = ema50 > 0 ? Math.abs(last - ema50) / ema50 : 0;
    const overstretched     = priceFromEMA50Pct > 0.03; // > 3% from EMA50 = risky

    let score = 10;
    if (trendAligned)    { score += 7;  reasons.push('✓ EMA trend aligned (+7)'); }
    else                 { score -= 3;  reasons.push('⚠ EMA trend not aligned (-3)'); }
    if (overstretched)   { score -= 5;  reasons.push('⚠ Price overstretched from EMA50 (-5)'); }
    else                 { score += 3;  reasons.push('✓ Price near EMA50 (+3)'); }

    return Math.max(0, Math.min(20, score));
  }

  private scoreSessionTiming(timestamp: number, reasons: string[]): number {
    const hour = new Date(timestamp).getUTCHours();

    // Best: London-NY overlap (13–17 UTC)
    if (hour >= SESSIONS.OVERLAP_LDN_NY.start && hour < SESSIONS.OVERLAP_LDN_NY.end) {
      reasons.push(`✓ London-NY overlap session (${hour}:00 UTC) (+15)`);
      return 15;
    }
    // Good: London session
    if (hour >= SESSIONS.LONDON.start && hour < SESSIONS.LONDON.end) {
      reasons.push(`✓ London session (${hour}:00 UTC) (+10)`);
      return 10;
    }
    // OK: New York session
    if (hour >= SESSIONS.NEWYORK.start && hour < SESSIONS.NEWYORK.end) {
      reasons.push(`✓ New York session (${hour}:00 UTC) (+8)`);
      return 8;
    }
    // Poor: Tokyo
    if (hour >= SESSIONS.TOKYO.start && hour < SESSIONS.TOKYO.end) {
      reasons.push(`⚠ Tokyo session (${hour}:00 UTC) (+4)`);
      return 4;
    }
    // Dead zone: 22–00 UTC
    reasons.push(`✗ Dead zone session (${hour}:00 UTC) (+0)`);
    return 0;
  }

  private scoreVolumeConfirmation(candles: Candle[], reasons: string[]): number {
    if (candles.length < 25) return 7;

    const volumes = candles.map(c => c.volume);
    const vol20   = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const lastVol = volumes[volumes.length - 1];
    const ratio   = vol20 > 0 ? lastVol / vol20 : 1;

    if (ratio >= 2.0)  { reasons.push(`✓ Strong volume surge ${ratio.toFixed(1)}× avg (+15)`); return 15; }
    if (ratio >= 1.5)  { reasons.push(`✓ Good volume ${ratio.toFixed(1)}× avg (+12)`);          return 12; }
    if (ratio >= 1.2)  { reasons.push(`✓ Above-avg volume ${ratio.toFixed(1)}× (+8)`);          return 8;  }
    if (ratio >= 0.8)  { reasons.push(`⚠ Normal volume ${ratio.toFixed(1)}× (+5)`);             return 5;  }
    reasons.push(`✗ Low volume ${ratio.toFixed(1)}× avg (+2)`);
    return 2;
  }

  private scoreRegimeFit(source: string, regime: MarketRegime, reasons: string[]): number {
    const engines  = source.toUpperCase().split('+');
    const hasTrend = engines.some(e => e.includes('TREND'));
    const hasRSI   = engines.some(e => e.includes('RSI'));
    const hasBO    = engines.some(e => e.includes('BREAKOUT'));

    switch (regime) {
      case 'TRENDING':
        if (hasTrend) { reasons.push('✓ TREND engine fits TRENDING market (+20)'); return 20; }
        if (hasBO)    { reasons.push('✓ BREAKOUT engine fits TRENDING market (+15)'); return 15; }
        if (hasRSI)   { reasons.push('⚠ RSI in TRENDING market (risky) (+6)'); return 6; }
        reasons.push('⚠ Unknown engine in TRENDING (+10)'); return 10;

      case 'RANGING':
        if (hasRSI)   { reasons.push('✓ RSI engine fits RANGING market (+20)'); return 20; }
        if (hasTrend) { reasons.push('✗ TREND engine in RANGING market (poor fit) (+4)'); return 4; }
        if (hasBO)    { reasons.push('⚠ BREAKOUT in RANGING (false break risk) (+6)'); return 6; }
        reasons.push('⚠ Unknown engine in RANGING (+10)'); return 10;

      case 'VOLATILE':
        reasons.push('✗ VOLATILE market — all strategies penalized (+3)'); return 3;

      default:
        reasons.push('⚠ Unknown regime — neutral (+10)'); return 10;
    }
  }

  private scoreRewardRisk(signal: Signal, reasons: string[]): number {
    const risk   = Math.abs(signal.price - signal.sl);
    const reward = Math.abs(signal.tp - signal.price);
    if (risk === 0) { reasons.push('✗ Invalid SL (zero risk distance)'); return 0; }

    const rr = reward / risk;
    if (rr >= 3.0)  { reasons.push(`✓ Excellent R:R = ${rr.toFixed(1)} (+15)`); return 15; }
    if (rr >= 2.0)  { reasons.push(`✓ Good R:R = ${rr.toFixed(1)} (+12)`);      return 12; }
    if (rr >= 1.5)  { reasons.push(`✓ Acceptable R:R = ${rr.toFixed(1)} (+8)`); return 8;  }
    if (rr >= 1.0)  { reasons.push(`⚠ Marginal R:R = ${rr.toFixed(1)} (+4)`);   return 4;  }
    reasons.push(`✗ Poor R:R = ${rr.toFixed(1)} (<1.0) (+0)`);
    return 0;
  }

  private scoreSourceHistory(winRate: number, reasons: string[]): number {
    if (winRate >= 0.65) { reasons.push(`✓ Strong source win rate ${pct(winRate)} (+15)`); return 15; }
    if (winRate >= 0.58) { reasons.push(`✓ Good source win rate ${pct(winRate)} (+11)`);   return 11; }
    if (winRate >= 0.50) { reasons.push(`⚠ Average source win rate ${pct(winRate)} (+7)`); return 7;  }
    if (winRate >= 0.42) { reasons.push(`⚠ Below-avg win rate ${pct(winRate)} (+4)`);      return 4;  }
    reasons.push(`✗ Poor source win rate ${pct(winRate)} (+1)`);
    return 1;
  }

  // ─── Volume multiplier ────────────────────────────────────────────────────

  private computeVolumeMultiplier(total: number, grade: string): number {
    // Grade A/B: normal or slightly increased size
    // Grade C:   normal
    // Grade D/F: reduced
    if (grade === 'A')         return 1.2;
    if (grade === 'B')         return 1.0;
    if (grade === 'C')         return 0.85;
    if (grade === 'D')         return 0.65;
    return 0.5; // F
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private ema(values: number[], period: number): number {
    if (values.length < period) return values[values.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

// ── V7 patch: update regimeFit to recognise new engine names ──────────────
// The method is overridden in-place via monkey-patch at module init time.
// This avoids breaking the class boundary while adding MACD_DIV, ICHIMOKU etc.
const _origRegimeFit = (SignalQualityScorer.prototype as any)['scoreRegimeFit'].bind;
(SignalQualityScorer.prototype as any)['_scoreRegimeFitBase'] =
  (SignalQualityScorer.prototype as any)['scoreRegimeFit'];

(SignalQualityScorer.prototype as any)['scoreRegimeFit'] = function(
  source: string, regime: string, reasons: string[]
): number {
  const engines  = source.toUpperCase().split('+');
  const hasTrend = engines.some(e => e.includes('TREND') || e.includes('ICHIMOKU'));
  const hasRSI   = engines.some(e => e.includes('RSI')   || e.includes('STOCH')   || e.includes('VWAP'));
  const hasBO    = engines.some(e => e.includes('BREAKOUT'));
  const hasMacd  = engines.some(e => e.includes('MACD'));

  switch (regime) {
    case 'TRENDING':
      if (hasTrend) { reasons.push('✓ Trend/Ichimoku fits TRENDING (+20)'); return 20; }
      if (hasBO)    { reasons.push('✓ BREAKOUT fits TRENDING (+15)');       return 15; }
      if (hasMacd)  { reasons.push('✓ MACD_DIV in TRENDING (+13)');        return 13; }
      if (hasRSI)   { reasons.push('⚠ RSI/VWAP in TRENDING (+6)');         return 6;  }
      return 10;
    case 'RANGING':
      if (hasRSI)   { reasons.push('✓ RSI/VWAP/StochRSI fits RANGING (+20)'); return 20; }
      if (hasMacd)  { reasons.push('✓ MACD_DIV in RANGING (+14)');            return 14; }
      if (hasTrend) { reasons.push('✗ Trend engine in RANGING (+4)');          return 4;  }
      if (hasBO)    { reasons.push('⚠ BREAKOUT in RANGING (+6)');              return 6;  }
      return 10;
    case 'VOLATILE':
      reasons.push('✗ VOLATILE market (+3)'); return 3;
    default:
      reasons.push('⚠ Unknown regime (+10)'); return 10;
  }
};
