/**
 * AUTO SYMBOL DISCOVERY — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يفحص تلقائياً قائمة الأزواج المتاحة ويختار أفضل 10–15 بناءً على:
 *   1. ATR% في النطاق المثالي (0.5% – 3%)
 *   2. Spread معقول (< 5 pips)
 *   3. حجم تداول كافٍ (volume > متوسط)
 *   4. ADX مناسب (> 15) — السوق ليس في سبات
 *   5. ليس في قائمة الحظر (مثال: أزواج exotic عالية الانتشار)
 *
 * يُحدَّث كل 24 ساعة ويُخزَّن في DB.
 * يُرجع قائمة مرتّبة بالدرجة (Score).
 * ══════════════════════════════════════════════════════════════════════════
 */
import { MarketScanner }   from '../core/MarketScanner';
import { DatabaseManager } from '../database/DatabaseManager';
import { calculateATR, atrPercent } from '../utils/ATR';
import { ADX }             from 'technicalindicators';
import { getSymbolSpec }   from '../config/symbolConfig';
import { Logger }          from '../utils/Logger';

export interface SymbolScore {
  symbol:      string;
  score:       number;   // 0..100
  atrPct:      number;
  adx:         number;
  spreadPips:  number;
  volumeScore: number;
  suitable:    boolean;
  reason:      string;
}

// Candidate universe
const CANDIDATE_FOREX = [
  'EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD',
  'EURGBP','EURJPY','GBPJPY','AUDJPY','CADJPY','CHFJPY',
  'EURCHF','EURCAD','GBPAUD','GBPCAD','GBPCHF','AUDCAD','AUDNZD',
];

const CANDIDATE_METALS  = ['XAUUSD','XAGUSD'];
const CANDIDATE_INDICES = ['US30','SPX500','NAS100','GER40'];
const CANDIDATE_CRYPTO  = ['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','SOLUSDT'];

const ALL_CANDIDATES = [
  ...CANDIDATE_FOREX, ...CANDIDATE_METALS,
  ...CANDIDATE_INDICES, ...CANDIDATE_CRYPTO,
];

const BLACKLIST = ['EXOTIC','USDZAR','USDRUB','USDBRL']; // high spread pairs

const MAX_SELECTED = 15;
const MIN_SCORE    = 40;

export class AutoSymbolDiscovery {
  private logger   = new Logger('SymbolDiscovery');
  private lastScan = 0;
  private results: SymbolScore[] = [];

  constructor(
    private scanner: MarketScanner,
    private db:      DatabaseManager,
  ) {}

  /** Returns best symbols — re-scans every 24h */
  async getBestSymbols(mode: 'mt5' | 'binance' | 'paper'): Promise<string[]> {
    if (Date.now() - this.lastScan < 24 * 3_600_000 && this.results.length > 0) {
      return this.results.filter(r => r.suitable).map(r => r.symbol);
    }

    this.logger.info('Auto Symbol Discovery: scanning candidates...');
    const scored = await this.scan(mode);

    this.results = scored;
    this.lastScan = Date.now();

    // Persist
    const best = scored.filter(r => r.suitable).map(r => r.symbol);
    this.db.setSetting('auto_symbols', JSON.stringify({ symbols: best, updatedAt: Date.now() }));

    this.logger.info(`Discovery complete: ${best.length} symbols selected: ${best.join(', ')}`);
    return best;
  }

  async scan(mode: 'mt5' | 'binance' | 'paper'): Promise<SymbolScore[]> {
    // For Binance: only crypto; for MT5/paper: all
    const candidates = mode === 'binance'
      ? CANDIDATE_CRYPTO
      : ALL_CANDIDATES;

    const scored: SymbolScore[] = [];

    for (const symbol of candidates) {
      if (BLACKLIST.some(b => symbol.includes(b))) continue;
      try {
        const score = await this.scoreSymbol(symbol);
        scored.push(score);
        await this.sleep(100); // rate limit
      } catch (e: any) {
        this.logger.debug(`[${symbol}] Score failed: ${e.message}`);
        scored.push({
          symbol, score: 0, atrPct: 0, adx: 0, spreadPips: 0,
          volumeScore: 0, suitable: false, reason: e.message,
        });
      }
    }

    // Sort by score, take top MAX_SELECTED
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, MAX_SELECTED);
    top.forEach(s => { if (s.score < MIN_SCORE) s.suitable = false; });

    return top;
  }

  private async scoreSymbol(symbol: string): Promise<SymbolScore> {
    const spec    = getSymbolSpec(symbol);
    const candles = await this.scanner.fetchCandles(symbol as any, 'H1', 100);
    if (!candles || candles.length < 50) {
      return { symbol, score: 0, atrPct: 0, adx: 0, spreadPips: 0, volumeScore: 0, suitable: false, reason: 'No data' };
    }

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const last    = candles[candles.length - 1];

    // ATR%
    const atrPct = atrPercent(candles, 14) * 100;

    // ADX
    let adx = 20;
    try {
      const adxR = ADX.calculate({ period: 14, close: closes, high: highs, low: lows });
      adx = adxR[adxR.length - 1]?.adx ?? 20;
    } catch {}

    // Spread estimate (from high-low of last 20 candles)
    const spreadPips = ((highs.slice(-20).reduce((s, v) => s + v, 0) / 20) -
                        (lows.slice(-20).reduce((s, v) => s + v, 0)  / 20))
                        / spec.pip * 0.05;

    // Volume score: current vs 20-bar average
    const avgVol = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const volumeScore = avgVol > 0 ? Math.min(1, last.volume / avgVol) : 0.5;

    // ── Scoring ────────────────────────────────────────────────────────
    let score = 0;
    const reasons: string[] = [];

    // ATR% score (ideal: 0.5% – 2.5%)
    if (atrPct >= 0.5 && atrPct <= 2.5) {
      score += 30;
      reasons.push(`ATR%=${atrPct.toFixed(2)}% ✓`);
    } else if (atrPct > 2.5 && atrPct <= 4) {
      score += 15;
      reasons.push(`ATR%=${atrPct.toFixed(2)}% (high)`);
    } else {
      reasons.push(`ATR%=${atrPct.toFixed(2)}% ✗`);
    }

    // ADX score
    if (adx >= 20 && adx <= 45) {
      score += 25;
      reasons.push(`ADX=${adx.toFixed(0)} ✓`);
    } else if (adx > 15) {
      score += 12;
      reasons.push(`ADX=${adx.toFixed(0)} (weak)`);
    } else {
      reasons.push(`ADX=${adx.toFixed(0)} ✗`);
    }

    // Spread score
    if (spreadPips <= 2) {
      score += 25;
      reasons.push(`Spread≈${spreadPips.toFixed(1)} ✓`);
    } else if (spreadPips <= 4) {
      score += 10;
      reasons.push(`Spread≈${spreadPips.toFixed(1)} (ok)`);
    } else {
      reasons.push(`Spread≈${spreadPips.toFixed(1)} ✗`);
    }

    // Volume score
    score += Math.round(volumeScore * 20);

    const suitable = score >= MIN_SCORE;
    return {
      symbol, score, atrPct, adx, spreadPips, volumeScore: +volumeScore.toFixed(2),
      suitable, reason: reasons.join(', '),
    };
  }

  getLastResults(): SymbolScore[] { return this.results; }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Load persisted symbols on startup */
  loadFromDB(): string[] {
    try {
      const s = this.db.getSetting('auto_symbols');
      if (!s) return [];
      const d = JSON.parse(s);
      if (Date.now() - d.updatedAt > 24 * 3_600_000) return [];
      return d.symbols ?? [];
    } catch { return []; }
  }
}
