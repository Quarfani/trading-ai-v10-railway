/**
 * LIVE CURRENCY CONVERSION PROVIDER
 *
 * Resolves quote-currency -> account-currency from broker market data.
 * Results are cached briefly to avoid turning one risk decision into many
 * network calls. Missing conversion is always returned as null.
 */
import { MarketScanner } from '../core/MarketScanner';
import { normalizeSymbol } from './market.types';
import { resolveQuoteToAccount } from './CurrencyConverter';

interface CacheEntry {
  rates: Record<string, number>;
  resolvedRate: number;
  fetchedAt: number;
}

const TTL_MS = 30_000;
const STABLE_USD = new Set(['USD', 'USDT', 'USDC', 'BUSD']);

function currency(value: string): string {
  return value.trim().toUpperCase();
}

export class CurrencyConversionProvider {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly scanner: MarketScanner,
    private readonly accountCurrency = 'USD',
  ) {}

  async getRates(quoteCurrency: string): Promise<Record<string, number> | null> {
    const quote = currency(quoteCurrency);
    const account = currency(this.accountCurrency);

    if (!quote || !account) return null;
    if (quote === account) return {};
    if (account === 'USD' && STABLE_USD.has(quote)) return {};

    const cached = this.cache.get(quote);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      return { ...cached.rates };
    }

    const candidates = [
      normalizeSymbol(quote + account),
      normalizeSymbol(account + quote),
    ];

    for (const symbol of [...new Set(candidates)]) {
      if (!symbol || symbol.length < 6) continue;

      const candles = await this.scanner
        .fetchCandles(symbol, 'M1', 2)
        .catch(() => []);

      const close = candles.at(-1)?.close;
      if (!Number.isFinite(close) || close <= 0) continue;

      const rates: Record<string, number> = {
        [symbol]: close,
      };

      const resolvedRate = resolveQuoteToAccount(
        quote,
        account,
        rates,
      );

      if (resolvedRate == null) continue;

      this.cache.set(quote, {
        rates,
        resolvedRate,
        fetchedAt: Date.now(),
      });

      return { ...rates };
    }

    return null;
  }

  async getRate(quoteCurrency: string): Promise<number | null> {
    const quote = currency(quoteCurrency);
    const account = currency(this.accountCurrency);

    if (quote === account) return 1;
    if (account === 'USD' && STABLE_USD.has(quote)) return 1;

    const cached = this.cache.get(quote);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      return cached.resolvedRate;
    }

    const rates = await this.getRates(quote);
    if (!rates) return null;

    return resolveQuoteToAccount(
      quote,
      account,
      rates,
    );
  }

  clear(): void {
    this.cache.clear();
  }
}
