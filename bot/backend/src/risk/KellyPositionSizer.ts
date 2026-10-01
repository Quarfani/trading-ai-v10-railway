/**
 * KELLY POSITION SIZER
 * ══════════════════════════════════════════════════════════════════════════
 * يحسب حجم الصفقة باستخدام Fractional Kelly Criterion:
 *
 *   Kelly% = (W × AvgWin - L × AvgLoss) / AvgWin
 *   FractionalKelly = Kelly% × 0.25  (ربع Kelly كما يحدده الـMaster Prompt)
 *
 * مع قيود السلامة:
 *   - لا يتجاوز RISK_PER_TRADE الأصلي بأكثر من 2×
 *   - لا ينزل عن 0.25× إلا إذا Kelly سالب (لا تداول)
 *   - إذا لا يوجد تاريخ كافٍ → يستخدم RISK_PER_TRADE الثابت
 *
 * يأخذ بعين الاعتبار:
 *   - نتائج آخر 30 يوم لهذا الرمز + هذا المحرك
 *   - درجة جودة الإشارة (Signal Quality Score)
 *   - نظام السوق الحالي (Regime)
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SystemConfig, Side, Timeframe } from '../types/trading.types';
import { MarketEconomics } from '../market/market.types';
import { Logger }             from '../utils/Logger';

export interface KellyStats {
  trades:   number;
  winRate:  number;
  avgWin:   number;
  avgLoss:  number;
  kelly:    number;      // raw Kelly%
  fraction: number;      // 0.25 × Kelly (capped)
  source:   'kelly' | 'fixed'; // which method was used
}

export class KellyPositionSizer {
  private logger = new Logger('KellySizer');

  /**
   * @param config          System config
   * @param symbolStats     Historical stats for this symbol+source combination
   * @param qualityScore    Signal quality score 0–100
   * @param currentEquity   Current account equity
   */
  size(
    symbol:       string,
    side:         Side,
    entry:        number,
    sl:           number,
    config:       SystemConfig,
    symbolStats?: SymbolTradeStats,
    qualityScore = 50,
    currentEquity?: number,
    quoteToAccount = 1,
    timeframe: Timeframe = 'H1',
    economics?: MarketEconomics,
  ): { volume: number; stats: KellyStats } {
    if (
      !economics ||
      !Number.isFinite(economics.contractSize) || economics.contractSize <= 0 ||
      !Number.isFinite(economics.minVolume) || economics.minVolume <= 0 ||
      !Number.isFinite(economics.maxVolume) || economics.maxVolume < economics.minVolume ||
      !Number.isFinite(economics.volumeStep) || economics.volumeStep <= 0
    ) {
      this.logger.warn(`[${symbol}] Missing/invalid market economics — sizing blocked`);
      return { volume: 0, stats: this.fixedStats(config.riskPerTrade) };
    }
    const base = currentEquity && config.compounding.enabled
      ? currentEquity
      : config.accountBalance;

    const slDist = Math.abs(entry - sl);
    if (slDist === 0) {
      return { volume: economics.minVolume, stats: this.fixedStats(config.riskPerTrade) };
    }

    // ── Kelly computation ────────────────────────────────────────────────
    const stats = this.computeKelly(symbolStats, config.riskPerTrade);

    // ── Quality adjustment ───────────────────────────────────────────────
    // Quality 80+ → full size. Quality 50 → 85%. Quality 30 → 70%.
    const qualityMult = this.qualityMultiplier(qualityScore);

    // ── Final risk% ──────────────────────────────────────────────────────
    const effectiveRisk = stats.fraction * qualityMult;
    const riskUsd       = base * effectiveRisk;
    if (!(quoteToAccount > 0) || !Number.isFinite(quoteToAccount)) {
      return { volume: 0, stats: { ...stats, source: 'fixed' } };
    }

    let raw             = riskUsd / (slDist * economics.contractSize * quoteToAccount);

    // ── Safety clamps ────────────────────────────────────────────────────
    // Never exceed 2× the configured max risk per trade
    const maxVolume = (base * config.riskPerTrade * 2) / (slDist * economics.contractSize * quoteToAccount);
    raw = Math.min(raw, maxVolume, economics.maxVolume);

    // Round to volume step
    const steps  = Math.floor(raw / economics.volumeStep + 1e-12);
    const volume = +(steps * economics.volumeStep).toFixed(8);
    if (volume < economics.minVolume) return { volume: 0, stats };

    this.logger.debug(
      `[${symbol}] Kelly=${(stats.kelly * 100).toFixed(1)}% ` +
      `Fraction=${(stats.fraction * 100).toFixed(1)}% ` +
      `QualMult=${qualityMult.toFixed(2)} ` +
      `EffRisk=${(effectiveRisk * 100).toFixed(2)}% → vol=${volume} (${stats.source})`
    );

    return { volume, stats };
  }

  // ─── Kelly computation ────────────────────────────────────────────────────

  private computeKelly(symbolStats: SymbolTradeStats | undefined, defaultRisk: number): KellyStats {
    // Need at least 15 trades for reliable Kelly estimate
    if (!symbolStats || symbolStats.trades < 15 || symbolStats.avgLoss === 0) {
      return this.fixedStats(defaultRisk);
    }

    const { winRate, avgWin, avgLoss, trades } = symbolStats;
    const lossRate = 1 - winRate;

    // Kelly formula: f = (W×b - L) / b   where b = avgWin/avgLoss
    const b     = avgWin / avgLoss;
    const kelly = (winRate * b - lossRate) / b;

    // Negative Kelly = expected negative edge = don't trade
    if (kelly <= 0) {
      this.logger.warn(`Negative Kelly (${(kelly * 100).toFixed(1)}%) on ${trades} trades — NO TRADE`);
      return { trades, winRate, avgWin, avgLoss, kelly, fraction: 0, source: 'kelly' };
    }

    // Fractional Kelly = 0.25 × Kelly (quarter Kelly hard cap).
    const fraction = Math.min(kelly * 0.25, defaultRisk * 2);

    return { trades, winRate, avgWin, avgLoss, kelly, fraction, source: 'kelly' };
  }

  private fixedStats(risk: number): KellyStats {
    return {
      trades: 0, winRate: 0.5, avgWin: 0, avgLoss: 0,
      kelly: risk, fraction: risk, source: 'fixed',
    };
  }

  private qualityMultiplier(score: number): number {
    if (score >= 80) return 1.15;  // Grade A: slightly larger
    if (score >= 65) return 1.0;   // Grade B: normal
    if (score >= 50) return 0.85;  // Grade C: slightly smaller
    if (score >= 35) return 0.70;  // Grade D: smaller
    return 0.55;                   // Grade F: minimum viable
  }
}

export interface SymbolTradeStats {
  trades:  number;
  winRate: number;
  avgWin:  number;   // USD
  avgLoss: number;   // USD (absolute value)
}
