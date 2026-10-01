/**
 * HISTORICAL CURRENCY SERIES LOADER
 *
 * Builds a deterministic currency-pair history from an injected candle fetcher.
 * No broker or network dependency is embedded here, making it testable.
 */
import { HistoricalRateSeries } from './HistoricalCurrencySeries';

export interface CurrencyRateCandle {
  time: number;
  close: number;
}

export type CurrencyRateFetcher = (
  symbol: string,
  count: number,
) => Promise<CurrencyRateCandle[]>;

function normalizeCurrency(value: string): string {
  return value.trim().toUpperCase();
}

function normalizePair(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function isIdentityOrUsdEquivalent(
  quote: string,
  account: string,
): boolean {
  if (quote === account) return true;
  return (
    account === 'USD' &&
    ['USD', 'USDT', 'USDC', 'BUSD'].includes(quote)
  );
}

export async function loadHistoricalCurrencySeries(
  quoteCurrency: string,
  accountCurrency: string,
  fetcher: CurrencyRateFetcher,
  count = 2000,
): Promise<HistoricalRateSeries> {
  const quote = normalizeCurrency(quoteCurrency);
  const account = normalizeCurrency(accountCurrency);

  if (
    !quote ||
    !account ||
    isIdentityOrUsdEquivalent(quote, account)
  ) {
    return {};
  }

  const candidates = [
    normalizePair(quote + account),
    normalizePair(account + quote),
  ];

  for (const pair of [...new Set(candidates)]) {
    try {
      const candles = await fetcher(pair, count);
      const points = (candles ?? [])
        .filter(
          candle =>
            Number.isFinite(candle.time) &&
            Number.isFinite(candle.close) &&
            candle.close > 0,
        )
        .map(candle => ({
          time: candle.time,
          rate: candle.close,
        }))
        .sort((a, b) => a.time - b.time);

      if (points.length > 0) {
        return {
          [pair]: points,
        };
      }
    } catch {
      // Try the inverse candidate before failing closed.
    }
  }

  return {};
}
