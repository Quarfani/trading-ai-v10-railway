/**
 * HISTORICAL ACCOUNT-CURRENCY CONVERSION
 *
 * Research-only, deterministic conversion resolver.
 * Rates are timestamped market observations. Missing/stale observations fail closed.
 */
export interface HistoricalRatePoint {
  time: number;
  rate: number;
}

export type HistoricalRateSeries = Record<string, HistoricalRatePoint[]>;

function normalize(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeSymbol(value: string): string {
  return normalize(value).replace(/[^A-Z0-9]/g, '');
}

function validRate(rate: number): boolean {
  return Number.isFinite(rate) && rate > 0;
}

function rateAt(
  points: HistoricalRatePoint[] | undefined,
  timestamp: number,
  maxAgeMs: number,
): number | null {
  if (!points?.length || !Number.isFinite(timestamp)) return null;

  let lo = 0;
  let hi = points.length - 1;
  let best: HistoricalRatePoint | null = null;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const point = points[mid];
    if (!point || !Number.isFinite(point.time) || !validRate(point.rate)) {
      lo = mid + 1;
      continue;
    }
    if (point.time <= timestamp) {
      best = point;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (!best) return null;
  if (timestamp - best.time > maxAgeMs) return null;
  return best.rate;
}

/**
 * Resolve quote currency -> account currency at a historical timestamp.
 * Direct pair QUOTEACCOUNT is preferred; otherwise ACCOUNTQUOTE is inverted.
 */
export function resolveHistoricalQuoteToAccount(
  quoteCurrency: string,
  accountCurrency: string,
  timestamp: number,
  series: HistoricalRateSeries,
  maxAgeMs = 24 * 60 * 60 * 1000,
): number | null {
  const quote = normalize(quoteCurrency);
  const account = normalize(accountCurrency);
  if (!quote || !account || !Number.isFinite(timestamp)) return null;
  if (quote === account) return 1;
  if (account === 'USD' && ['USD', 'USDT', 'USDC', 'BUSD'].includes(quote)) return 1;

  const direct = rateAt(series[normalizeSymbol(quote + account)], timestamp, maxAgeMs);
  if (direct != null) return direct;

  const inverse = rateAt(series[normalizeSymbol(account + quote)], timestamp, maxAgeMs);
  return inverse != null ? 1 / inverse : null;
}
