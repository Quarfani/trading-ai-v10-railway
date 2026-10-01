/**
 * HISTORICAL CURRENCY SERIES LOADER
 *
 * Builds a deterministic currency-pair history from an injected candle fetcher.
 * No broker or network dependency is embedded here, making it testable.
 */
import { HistoricalRateSeries } from './HistoricalCurrencySeries';
import { TIMEFRAME_MS } from './market.types';

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

  if (!quote || !account || isIdentityOrUsdEquivalent(quote, account)) {
    return {};
  }

  const directCandidates = [
    normalizePair(quote + account),
    normalizePair(account + quote),
  ];

  const loadPair = async (pair: string): Promise<HistoricalRateSeries> => {
    try {
      const candles = await fetcher(pair, count);
      const points = (candles ?? [])
        .filter(candle => Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.close > 0)
        .map(candle => ({
          // Candle timestamps are bar-open times. The close becomes known only
          // at the end of the D1 bar, so anchor the observation at its close.
          time: candle.time + TIMEFRAME_MS.D1 - 1,
          rate: candle.close,
        }))
        .sort((a, b) => a.time - b.time);
      return points.length ? { [pair]: points } : {};
    } catch {
      return {};
    }
  };

  for (const pair of [...new Set(directCandidates)]) {
    const loaded = await loadPair(pair);
    if (Object.keys(loaded).length) return loaded;
  }

  // USD bridge: load both quote/USD and account/USD legs.
  const legs = [
    normalizePair(quote + 'USD'),
    normalizePair('USD' + quote),
    normalizePair(account + 'USD'),
    normalizePair('USD' + account),
  ];
  const result: HistoricalRateSeries = {};
  for (const pair of [...new Set(legs)]) {
    Object.assign(result, await loadPair(pair));
  }

  return Object.keys(result).length >= 2 ? result : {};
}
