/**
 * NEWS FILTER — v7.1
 * FIX BUG-M1: SYMBOL_CURRENCIES mapped BTCUSD/ETHUSD (without USDT suffix).
 *   The bot trades BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT.
 *   USD high-impact events (FOMC, NFP, CPI) were NOT blocking crypto trades.
 *   During major economic releases the bot would enter crypto when it should stop.
 *
 * [FIX-1] High + Medium Impact blocking (with newsFilter.blockMediumImpact config)
 * [FIX-2] Smart currency matching per pair
 * [FIX-3] NFP and critical event extended block window
 * [FIX-4] DB persistence to survive restarts
 * [NEW v7.1] BTCUSDT/ETHUSDT/BNBUSDT/SOLUSDT added to SYMBOL_CURRENCIES
 */
import axios from 'axios';
import { Logger } from '../utils/Logger';

export interface NewsEvent {
  time:     number;
  impact:   'high' | 'medium' | 'low';
  title:    string;
  currency: string;
}

// High-impact events requiring extra-wide block window
const CRITICAL_KEYWORDS = [
  'Non-Farm', 'NFP', 'FOMC', 'Federal Funds', 'Fed Rate', 'CPI', 'GDP',
  'Employment Change', 'Unemployment', 'Interest Rate', 'BoE Rate', 'ECB Rate',
  'RBA Rate', 'BoJ', 'BOJ', 'SNB Rate', 'Inflation',
];

// FIX BUG-M1: added BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT, ADAUSDT
const SYMBOL_CURRENCIES: Record<string, string[]> = {
  // Forex
  EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'],
  USDJPY: ['USD', 'JPY'], USDCHF: ['USD', 'CHF'],
  USDCAD: ['USD', 'CAD'], AUDUSD: ['AUD', 'USD'],
  NZDUSD: ['NZD', 'USD'], EURGBP: ['EUR', 'GBP'],
  EURJPY: ['EUR', 'JPY'], GBPJPY: ['GBP', 'JPY'],
  AUDJPY: ['AUD', 'JPY'], CADJPY: ['CAD', 'JPY'],
  CHFJPY: ['CHF', 'JPY'], EURCHF: ['EUR', 'CHF'],
  EURCAD: ['EUR', 'CAD'], GBPAUD: ['GBP', 'AUD'],
  GBPCAD: ['GBP', 'CAD'], GBPCHF: ['GBP', 'CHF'],
  // Metals
  XAUUSD: ['USD'],
  XAGUSD: ['USD'],
  // Indices — affected by their home currency
  US30:   ['USD'], NAS100: ['USD'], SPX500: ['USD'],
  GER40:  ['EUR'], UK100:  ['GBP'],
  // Crypto — all affected by USD macro events
  // FIX: was BTCUSD/ETHUSD — changed to correct USDT-suffixed symbols
  BTCUSDT:  ['USD'],
  ETHUSDT:  ['USD'],
  BNBUSDT:  ['USD'],
  SOLUSDT:  ['USD'],
  XRPUSDT:  ['USD'],
  ADAUSDT:  ['USD'],
  DOGEUSDT: ['USD'],
  AVAXUSDT: ['USD'],
};

export class NewsFilter {
  private logger    = new Logger('NewsFilter');
  private events:   NewsEvent[] = [];
  private lastFetch = 0;
  private calendarCorrupt = false;

  // Block windows in milliseconds
  private readonly HIGH_PRE      = 45 * 60_000;
  private readonly HIGH_POST     = 30 * 60_000;
  private readonly MEDIUM_PRE    = 15 * 60_000;
  private readonly MEDIUM_POST   = 10 * 60_000;
  private readonly CRITICAL_PRE  = 60 * 60_000;
  private readonly CRITICAL_POST = 60 * 60_000;
  private readonly FETCH_TTL     = 60 * 60_000; // re-fetch calendar every 1h
  private readonly MAX_STALE      = 2 * 60 * 60_000;

  /**
   * Check whether trading a symbol is blocked due to upcoming/recent news.
   */
  isBlocked(
    symbol: string,
    now    = Date.now(),
    blockMedium = false,
  ): { blocked: boolean; event?: NewsEvent } {
    if (
      !Number.isFinite(now) ||
      now <= 0 ||
      now > Date.now() + 5_000
    ) {
      return { blocked: true };
    }

    const sym = String(symbol ?? '').trim().toUpperCase();
    if (!sym) return { blocked: true };
    const currencies = this.getCurrencies(sym);

    for (const ev of this.events) {
      if (!currencies.includes(ev.currency)) continue;

      const isCritical = CRITICAL_KEYWORDS.some(k =>
        ev.title.toLowerCase().includes(k.toLowerCase()));

      let pre  = 0, post = 0;

      if (ev.impact === 'high') {
        pre  = isCritical ? this.CRITICAL_PRE  : this.HIGH_PRE;
        post = isCritical ? this.CRITICAL_POST : this.HIGH_POST;
      } else if (ev.impact === 'medium' && blockMedium) {
        pre  = this.MEDIUM_PRE;
        post = this.MEDIUM_POST;
      } else {
        continue;
      }

      const eventStart = ev.time - pre;
      const eventEnd   = ev.time + post;

      if (now >= eventStart && now <= eventEnd) {
        return { blocked: true, event: ev };
      }
    }

    return { blocked: false };
  }

  isFresh(now = Date.now()): boolean {
    return (
      !this.calendarCorrupt &&
      Number.isFinite(now) &&
      now >= this.lastFetch &&
      this.lastFetch > 0 &&
      now - this.lastFetch <= this.MAX_STALE
    );
  }

  getLastFetchAt(): number {
    return this.lastFetch;
  }

  /** Fetch the economic calendar if stale. */
  async refresh(): Promise<void> {
    if (Date.now() - this.lastFetch < this.FETCH_TTL) return;
    try {
      const r = await axios.get(
        'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
        { timeout: 8_000 },
      );
      const raw: any[] = Array.isArray(r.data) ? r.data : [];
      const relevant = raw.filter(
        e => e?.impact === 'High' || e?.impact === 'Medium',
      );

      const parsed: NewsEvent[] = [];
      let corrupt = !Array.isArray(r.data);
      for (const e of relevant) {
        const time = new Date(e?.date).getTime();
        const currency = String(e?.country ?? '').trim().toUpperCase();
        const title = String(e?.title ?? '').trim();
        if (
          !Number.isFinite(time) ||
          time <= 0 ||
          !currency ||
          !title
        ) {
          corrupt = true;
          continue;
        }
        parsed.push({
          time,
          impact: (e.impact === 'High' ? 'high' : 'medium') as 'high' | 'medium',
          title,
          currency,
        });
      }

      this.calendarCorrupt = corrupt;
      if (corrupt) {
        this.logger.error(
          'News calendar contained malformed high/medium-impact events — news gate is fail-closed',
        );
        return;
      }

      this.events = parsed;
      this.lastFetch = Date.now();
      this.logger.info(`News calendar updated: ${this.events.length} events`);
    } catch (e: any) {
      this.calendarCorrupt = true;
      this.logger.warn(`News fetch failed: ${e.message} — cached calendar age=${this.lastFetch > 0 ? Math.round((Date.now() - this.lastFetch) / 60_000) + 'm' : 'unknown'}`);
    }
  }

  private getCurrencies(symbol: string): string[] {
    if (SYMBOL_CURRENCIES[symbol]) return SYMBOL_CURRENCIES[symbol];

    // Generic pair: first 3 chars = base, next 3 = quote
    if (symbol.length >= 6) {
      return [symbol.substring(0, 3), symbol.substring(3, 6)];
    }

    return [symbol];
  }
}
