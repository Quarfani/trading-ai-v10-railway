/**
 * SESSION FILTER — v9.0 FINAL
 * [FIX] Crypto (BTC/ETH/USDT) يتداول 24/7 — لا session filter
 * [FIX] Dead zone يُطبَّق فقط على FX/Metals
 * [NEW] Funding Rate window: Binance Futures يدفع كل 8h (00/08/16 UTC)
 *       → تجنب الدخول 5 دقائق قبل وبعد الـ funding
 */
import { Logger } from '../utils/Logger';

export type TradingSession = 'DEAD_ZONE' | 'TOKYO' | 'LONDON' | 'NEWYORK' | 'OVERLAP' | 'CRYPTO_24_7';

export interface SessionCheckResult {
  allowed:  boolean;
  session:  TradingSession;
  reason:   string;
  score:    number;
}

const ENGINE_SESSIONS: Record<string, TradingSession[]> = {
  TREND:     ['LONDON', 'NEWYORK', 'OVERLAP'],
  RSI:       ['TOKYO', 'LONDON', 'NEWYORK', 'OVERLAP'],
  BREAKOUT:  ['LONDON', 'NEWYORK', 'OVERLAP'],
  STRUCTURE: ['LONDON', 'NEWYORK', 'OVERLAP'],
  MACD_DIV:  ['LONDON', 'NEWYORK', 'OVERLAP'],
  ICHIMOKU:  ['TOKYO', 'LONDON', 'NEWYORK', 'OVERLAP'],
  STOCH_RSI: ['TOKYO', 'LONDON', 'NEWYORK', 'OVERLAP'],
  VWAP:      ['TOKYO', 'LONDON', 'NEWYORK', 'OVERLAP'],
  SR:        ['LONDON', 'NEWYORK', 'OVERLAP'],
};

// [FIX] Crypto symbols trade 24/7 — no session restrictions
const CRYPTO_SYMBOLS = ['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','AVAX','MATIC','DOT'];

// Binance Futures funding payment hours (UTC)
const FUNDING_HOURS = [0, 8, 16];
const FUNDING_BUFFER_MIN = 5; // block 5 min before/after

export class SessionFilter {
  private logger = new Logger('SessionFilter');

  check(source: string, symbol: string, tsMs = Date.now()): SessionCheckResult {
    if (
      !Number.isFinite(tsMs) ||
      tsMs <= 0 ||
      tsMs > Date.now() + 5_000
    ) {
      return {
        allowed: false,
        session: 'DEAD_ZONE',
        reason: '✗ Invalid market timestamp — trading blocked',
        score: 0,
      };
    }

    const sym = String(symbol ?? '').trim().toUpperCase();
    if (!sym) {
      return {
        allowed: false,
        session: 'DEAD_ZONE',
        reason: '✗ Invalid symbol — trading blocked',
        score: 0,
      };
    }

    // [FIX] Crypto: always allowed (24/7 market)
    const isCrypto = this.isCryptoSymbol(sym);
    if (isCrypto) {
      // But block near funding rate settlement
      const fundingBlock = this.isFundingWindow(tsMs);
      if (fundingBlock) {
        return {
          allowed: false,
          session: 'CRYPTO_24_7',
          reason: `⏳ Binance Futures funding rate window — wait 5 min`,
          score: 0,
        };
      }
      return { allowed: true, session: 'CRYPTO_24_7', reason: '✓ Crypto 24/7', score: 90 };
    }

    // FX / Metals / Indices: use session rules
    const session = this.currentSession(tsMs);

    if (session === 'DEAD_ZONE') {
      return {
        allowed: false, session,
        reason: `✗ Dead zone (${new Date(tsMs).getUTCHours()}:00 UTC) — FX market closed`,
        score: 0,
      };
    }

    const engines = source.toUpperCase().split('+');
    for (const engine of engines) {
      const allowed = ENGINE_SESSIONS[engine] ?? ['LONDON', 'NEWYORK', 'OVERLAP'];
      if (!allowed.includes(session)) {
        return {
          allowed: false, session,
          reason: `✗ ${engine} not permitted in ${session} session`,
          score: 20,
        };
      }
    }

    // JPY pairs: extra allowed in Tokyo
    const isJPY = sym.includes('JPY');
    if (session === 'TOKYO' && !isJPY) {
      const tokyoOk = engines.every(e =>
        ['ICHIMOKU','STOCH_RSI','VWAP','RSI'].includes(e)
      );
      if (!tokyoOk) {
        return {
          allowed: false, session,
          reason: `✗ Tokyo: only mean-reversion strategies for non-JPY`,
          score: 10,
        };
      }
    }

    const score = this.sessionScore(session);
    return { allowed: true, session, reason: `✓ ${session} (score=${score})`, score };
  }

  currentSession(tsMs = Date.now()): TradingSession {
    const dt = new Date(tsMs);
    const day = dt.getUTCDay();
    const hour = dt.getUTCHours();

    // Standard FX/Metals weekend closure in UTC:
    // Friday late session through Sunday before the market reopens.
    if (day === 6 || (day === 0 && hour < 22)) {
      return 'DEAD_ZONE';
    }

    if (hour >= 22 || hour < 1) return 'DEAD_ZONE';
    if (hour >= 13 && hour < 17) return 'OVERLAP';
    if (hour >= 17 && hour < 22) return 'NEWYORK';
    if (hour >= 8  && hour < 13) return 'LONDON';
    return 'TOKYO';
  }

  private isFundingWindow(tsMs: number): boolean {
    const dt  = new Date(tsMs);
    const h   = dt.getUTCHours();
    const m   = dt.getUTCMinutes();
    const minOfDay = h * 60 + m;

    for (const fh of FUNDING_HOURS) {
      const fundingMin = fh * 60;
      if (Math.abs(minOfDay - fundingMin) <= FUNDING_BUFFER_MIN) {
        return true;
      }
    }
    return false;
  }

  private sessionScore(s: TradingSession): number {
    return { OVERLAP: 100, NEWYORK: 85, LONDON: 80, TOKYO: 50, DEAD_ZONE: 0, CRYPTO_24_7: 90 }[s] ?? 0;
  }

  isTradeable(symbol?: string): boolean {
    const sym = String(symbol ?? '').trim().toUpperCase();
    if (!sym) return false;
    return this.isCryptoSymbol(sym)
      ? !this.isFundingWindow(Date.now())
      : this.currentSession() !== 'DEAD_ZONE';
  }

  private isCryptoSymbol(sym: string): boolean {
    return (
      CRYPTO_SYMBOLS.some(c => sym.startsWith(c)) ||
      sym.endsWith('USDT') ||
      sym.endsWith('USDC')
    );
  }
}
