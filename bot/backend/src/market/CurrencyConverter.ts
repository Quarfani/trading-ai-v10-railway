/**
 * ACCOUNT-CURRENCY CONVERSION
 * Resolves quote-currency -> account-currency using explicit market quotes.
 * Direct/inverse pairs are preferred; a conservative USD bridge is used only
 * when both currency legs are explicitly available.
 */
import { normalizeSymbol } from "./market.types";

const USD_EQUIVALENTS = new Set(["USD", "USDT", "USDC", "BUSD"]);

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

function resolveToUsd(currency: string, prices: Record<string, number>): number | null {
  const normalized = normalizeCurrency(currency);
  if (!normalized || normalized === "USD" || USD_EQUIVALENTS.has(normalized)) return 1;

  const direct = readPrice(prices, normalized + "USD");
  if (direct != null) return direct;

  const inverse = readPrice(prices, "USD" + normalized);
  return inverse != null ? 1 / inverse : null;
}

/** Resolve 1 unit of quote currency into account currency. */
export function resolveQuoteToAccount(
  quoteCurrency: string,
  accountCurrency: string,
  prices: Record<string, number> = {},
): number | null {
  const quote = normalizeCurrency(quoteCurrency);
  const account = normalizeCurrency(accountCurrency);

  if (!quote || !account) return null;
  if (quote === account) return 1;
  if (account === "USD" && USD_EQUIVALENTS.has(quote)) return 1;
  if (quote === "USD" && account === "USD") return 1;

  const direct = readPrice(prices, quote + account);
  if (direct != null) return direct;

  const inverse = readPrice(prices, account + quote);
  if (inverse != null) return 1 / inverse;

  const quoteToUsd = resolveToUsd(quote, prices);
  const accountToUsd = resolveToUsd(account, prices);

  if (quoteToUsd != null && accountToUsd != null && accountToUsd > 0) {
    return quoteToUsd / accountToUsd;
  }

  return null;
}