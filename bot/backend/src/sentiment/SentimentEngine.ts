/**
 * SENTIMENT ANALYSIS ENGINE — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يحلل مشاعر الأخبار الاقتصادية ويحوّلها إلى إشارة اتجاهية.
 *
 * المصادر:
 *   1. Forex Factory Calendar: الخبر الفعلي vs التوقع → Surprise Factor
 *   2. Fear & Greed Index: مشاعر السوق العامة (Crypto + Stocks)
 *   3. DXY Direction: اتجاه الدولار يؤثر على جميع أزواج USD
 *
 * المخرجات:
 *   - sentimentScore: -1 (bearish) → 0 (neutral) → +1 (bullish)
 *   - impact: 'STRONG' | 'MODERATE' | 'WEAK' | 'NEUTRAL'
 *   - bias: 'BUY' | 'SELL' | 'NONE' للرمز المعطى
 * ══════════════════════════════════════════════════════════════════════════
 */
import axios from 'axios';
import { Logger } from '../utils/Logger';

export interface SentimentResult {
  symbol:         string;
  sentimentScore: number;   // -1..+1
  impact:         'STRONG' | 'MODERATE' | 'WEAK' | 'NEUTRAL';
  bias:           'BUY' | 'SELL' | 'NONE';
  fearGreedIndex: number;   // 0..100 (0=extreme fear, 100=extreme greed)
  surpriseFactor: number;   // Actual vs Forecast difference (normalised)
  updatedAt:      number;
  reason:         string;
}

export interface EconomicEvent {
  title:    string;
  actual:   number | null;
  forecast: number | null;
  previous: number | null;
  currency: string;
  impact:   'high' | 'medium';
  time:     number;
}

const BULLISH_USD_EVENTS = ['NFP', 'Non-Farm', 'GDP', 'CPI', 'Retail Sales', 'ISM'];
const CACHE_TTL = 30 * 60_000; // 30 min

export class SentimentEngine {
  private logger = new Logger('Sentiment');
  private cache  = new Map<string, SentimentResult>();
  private events: EconomicEvent[] = [];
  private fearGreed = 50;
  private lastFetch = 0;

  async getSentiment(symbol: string): Promise<SentimentResult> {
    const cached = this.cache.get(symbol);
    if (cached && Date.now() - cached.updatedAt < CACHE_TTL) return cached;

    await this.refreshData();
    const result = this.computeSentiment(symbol);
    this.cache.set(symbol, result);
    return result;
  }

  async refreshData(): Promise<void> {
    if (Date.now() - this.lastFetch < CACHE_TTL) return;

    await Promise.allSettled([
      this.fetchFearGreed(),
      this.fetchEconomicEvents(),
    ]);

    this.lastFetch = Date.now();
    this.cache.clear(); // invalidate on new data
  }

  private computeSentiment(symbol: string): SentimentResult {
    const sym = symbol.toUpperCase();
    const currencies = this.getCurrencies(sym);

    let score  = 0;
    let weight = 0;
    const reasons: string[] = [];

    // ── 1. Fear & Greed (crypto/general market) ───────────────────────
    const fgNorm = (this.fearGreed - 50) / 50; // -1..+1
    if (sym.includes('BTC') || sym.includes('ETH')) {
      score  += fgNorm * 0.6;
      weight += 0.6;
      reasons.push(`F&G=${this.fearGreed} (${this.fearGreedLabel()})`);
    } else {
      score  += fgNorm * 0.1; // minor influence on forex
      weight += 0.1;
    }

    // ── 2. Recent economic event surprises ────────────────────────────
    const recent = this.events.filter(e => {
      const elapsed = Date.now() - e.time;
      return elapsed > 0 && elapsed < 4 * 3_600_000; // last 4 hours
    });

    for (const ev of recent) {
      if (!currencies.some(c => ev.currency === c)) continue;
      const surprise = this.calcSurprise(ev);
      if (surprise === null) continue;

      // Positive surprise for USD → USD stronger → SELL EURUSD, BUY USDJPY
      const isBase  = currencies[0] === ev.currency;
      const effect  = isBase ? surprise : -surprise;
      const evWeight = ev.impact === 'high' ? 0.5 : 0.3;

      score  += effect * evWeight;
      weight += evWeight;
      reasons.push(`${ev.title}: surprise=${surprise > 0 ? '+' : ''}${surprise.toFixed(2)}`);
    }

    const finalScore = weight > 0 ? Math.max(-1, Math.min(1, score / weight)) : 0;
    const bias: 'BUY' | 'SELL' | 'NONE' =
      finalScore >  0.3 ? 'BUY'  :
      finalScore < -0.3 ? 'SELL' : 'NONE';
    const impact: SentimentResult['impact'] =
      Math.abs(finalScore) > 0.6 ? 'STRONG'   :
      Math.abs(finalScore) > 0.3 ? 'MODERATE' :
      Math.abs(finalScore) > 0.1 ? 'WEAK'     : 'NEUTRAL';

    return {
      symbol, sentimentScore: +finalScore.toFixed(3),
      impact, bias,
      fearGreedIndex: this.fearGreed,
      surpriseFactor: +score.toFixed(3),
      updatedAt: Date.now(),
      reason: reasons.join(' | ') || 'No recent events',
    };
  }

  private calcSurprise(ev: EconomicEvent): number | null {
    if (ev.actual === null || ev.forecast === null) return null;
    const base = Math.abs(ev.forecast) || 1;
    return (ev.actual - ev.forecast) / base;
  }

  private async fetchFearGreed(): Promise<void> {
    try {
      const r = await axios.get('https://api.alternative.me/fng/', { timeout: 5_000 });
      const value = Number(r.data?.data?.[0]?.value);
      if (Number.isFinite(value) && value >= 0 && value <= 100) {
        this.fearGreed = value;
      }
    } catch { /* keep last value */ }
  }

  private async fetchEconomicEvents(): Promise<void> {
    try {
      const r = await axios.get(
        'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
        { timeout: 8_000 }
      );
      this.events = (r.data ?? [])
        .filter((e: any) => e.impact === 'High' || e.impact === 'Medium')
        .map((e: any) => ({
          title:    e.title ?? '',
          actual:   this.parseNum(e.actual),
          forecast: this.parseNum(e.forecast),
          previous: this.parseNum(e.previous),
          currency: (e.country ?? '').toUpperCase().slice(0, 3),
          impact:   e.impact === 'High' ? 'high' : 'medium',
          time:     new Date(e.date).getTime(),
        }));
    } catch { /* keep last */ }
  }

  private parseNum(v: string | undefined): number | null {
    if (!v) return null;
    const n = parseFloat(v.replace(/[%KMB,]/g, ''));
    return isNaN(n) ? null : n;
  }

  private getCurrencies(symbol: string): string[] {
    const normalized = String(symbol ?? '').toUpperCase().trim();
    const quoteSuffixes = ['USDT', 'USDC', 'BUSD', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
    const quote = quoteSuffixes.find(q => normalized.endsWith(q));
    if (quote && normalized.length > quote.length) {
      const base = normalized.slice(0, -quote.length);
      return [base, quote];
    }
    if (normalized.length >= 6) {
      return [normalized.slice(0, 3), normalized.slice(3, 6)];
    }
    return [normalized];
  }

  private fearGreedLabel(): string {
    if (this.fearGreed >= 75) return 'Extreme Greed';
    if (this.fearGreed >= 55) return 'Greed';
    if (this.fearGreed >= 45) return 'Neutral';
    if (this.fearGreed >= 25) return 'Fear';
    return 'Extreme Fear';
  }

  getStats() {
    return {
      fearGreedIndex: this.fearGreed,
      fearGreedLabel: this.fearGreedLabel(),
      recentEvents: this.events.filter(e => Math.abs(Date.now() - e.time) < 8 * 3_600_000).length,
      cacheSize: this.cache.size,
    };
  }
}

/**
 * ORDER FLOW ENGINE — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يحلل حجم التداول لاكتشاف ضغط الشراء/البيع.
 *
 * Volume Delta:  شمعات صاعدة → Buy pressure
 *                شمعات هابطة → Sell pressure
 *
 * Volume Profile: أين يتركّز أكثر الحجم؟ (POC = Point of Control)
 *
 * Institutional Signature:
 *   - حجم عالي جداً + شمعة صغيرة = Absorption (مؤسسة تمتص الضغط)
 *   - هذا يُشير لانعكاس وشيك
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Candle, Side } from '../types/trading.types';

export interface OrderFlowResult {
  buyVolume:       number;
  sellVolume:      number;
  delta:           number;   // buyVolume - sellVolume (positive = buy pressure)
  deltaRatio:      number;   // delta / totalVolume
  poc:             number;   // Point of Control price
  pocVolume:       number;
  absorption:      boolean;  // institutional absorption detected
  absorptionBias:  Side | null; // which side is being absorbed (signals opposite)
  bias:            'BUY' | 'SELL' | 'NEUTRAL';
  strength:        number;   // 0..1
}

export class OrderFlowEngine {
  analyze(candles: Candle[], lookback = 20): OrderFlowResult {
    const slice = candles.slice(-lookback);

    let buyVolume  = 0;
    let sellVolume = 0;
    const priceVolMap = new Map<number, number>();

    for (const c of slice) {
      // Estimate buy/sell volume from candle body direction
      const bodyRatio = c.open > 0 ? (c.close - c.open) / (c.high - c.low || 0.0001) : 0;
      const buyVol  = c.volume * Math.max(0, (bodyRatio + 1) / 2);
      const sellVol = c.volume - buyVol;
      buyVolume  += buyVol;
      sellVolume += sellVol;

      // Volume Profile: bucket price to nearest 0.01%
      const bucket = Math.round(c.close * 1000) / 1000;
      priceVolMap.set(bucket, (priceVolMap.get(bucket) ?? 0) + c.volume);
    }

    const totalVolume = buyVolume + sellVolume;
    const delta       = buyVolume - sellVolume;
    const deltaRatio  = totalVolume > 0 ? delta / totalVolume : 0;

    // Point of Control: price with most volume
    let pocPrice = 0, pocVol = 0;
    for (const [price, vol] of priceVolMap) {
      if (vol > pocVol) { pocVol = vol; pocPrice = price; }
    }

    // Absorption detection: high volume + small body
    const last   = slice[slice.length - 1];
    const avgVol = totalVolume / slice.length;
    const body   = Math.abs(last.close - last.open);
    const range  = last.high - last.low;
    const isHighVol   = last.volume > avgVol * 2;
    const isSmallBody = range > 0 && body / range < 0.25;
    const absorption  = isHighVol && isSmallBody;

    let absorptionBias: Side | null = null;
    if (absorption) {
      // Small body at top of range → selling absorbed → bullish
      const bodyPos = range > 0 ? (last.close - last.low) / range : 0.5;
      absorptionBias = bodyPos > 0.7 ? 'BUY' : bodyPos < 0.3 ? 'SELL' : null;
    }

    const bias: OrderFlowResult['bias'] =
      deltaRatio >  0.15 ? 'BUY'  :
      deltaRatio < -0.15 ? 'SELL' : 'NEUTRAL';
    const strength = Math.min(1, Math.abs(deltaRatio) * 4);

    return {
      buyVolume: +buyVolume.toFixed(2), sellVolume: +sellVolume.toFixed(2),
      delta: +delta.toFixed(2), deltaRatio: +deltaRatio.toFixed(4),
      poc: pocPrice, pocVolume: +pocVol.toFixed(2),
      absorption, absorptionBias, bias, strength,
    };
  }

  /** Returns true if order flow confirms signal direction */
  confirms(signal: Side, candles: Candle[]): boolean {
    const of = this.analyze(candles);
    if (of.absorption && of.absorptionBias === signal) return true;
    if (signal === 'BUY'  && of.deltaRatio >  0.10) return true;
    if (signal === 'SELL' && of.deltaRatio < -0.10) return true;
    return false;
  }
}
