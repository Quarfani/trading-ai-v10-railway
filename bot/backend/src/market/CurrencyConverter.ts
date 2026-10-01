/**
 * ACCOUNT-CURRENCY CONVERSION
 *
 * Resolves quote-currency -> account-currency using explicit market quotes.
 * USD stablecoins are treated as account-currency equivalents only when the
 * account currency is USD; non-USD conversions must be supplied explicitly.
 *
 * This module never fabricates a conversion rate.
 */
import { normalizeSymbol } from './market.types';

const USD_EQUIVALENTS = new Set(['USD', 'USDT', 'USDC', 'BUSD']);

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function readPrice(prices: Record<string, number>, symbol: string): number | null {
  const normalized = normalizeSymbol(symbol);

  for (const [key, value] of Object.entries(prices)) {
    if (normalizeSymbol(key) === normalized && Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}

/**
 * Resolve 1 unit of quote currency into account currency.
 */
export function resolveQuoteToAccount(
  quoteCurrency: string,
  accountCurrency: string,
  prices: Record<string, number> = {},
): number | null {
  const quote = normalizeCurrency(quoteCurrency);
  const account = normalizeCurrency(accountCurrency);

  if (!quote || !account) return null;
  if (quote === account) return 1;

  if (account === 'USD' && USD_EQUIVALENTS.has(quote)) return 1;
  if (quote === 'USD' && account === 'USD') return 1;

  // Direct: QUOTEACCOUNT, e.g. GBPUSD => GBP -> USD.
  const direct = readPrice(prices, `${quote}${account}`);
  if (direct != null) return direct;

  // Inverse: ACCOUNTQUOTE, e.g. USDJPY => 1 USDJPY = JPY per USD.
  const inverse = readPrice(prices, `${account}${quote}`);
  if (inverse != null) {
    return 1 / inverse;
  }

  return null;
}
