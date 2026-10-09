/**
 * HISTORICAL ACCOUNT-CURRENCY CONVERSION
 *
 * Deterministic conversion resolver for timestamped market observations.
 * Missing or stale observations fail closed; completed-bar timestamps prevent lookahead.
 */
export interface HistoricalRatePoint {
  time: number;
  rate: number;
}

export type HistoricalRateSeries = Record<string, HistoricalRatePoint[]>;

export interface HistoricalSeriesValidation {
  valid: boolean;
  errors: string[];
}

export function validateHistoricalRateSeries(
  series: HistoricalRateSeries,
): HistoricalSeriesValidation {
  const errors: string[] = [];

  for (const [rawKey, points] of Object.entries(series)) {
    const key = normalizeSymbol(rawKey);
    if (!key) {
      errors.push('empty currency-pair key');
      continue;
    }
    if (!Array.isArray(points) || points.length === 0) {
      errors.push(`${key}: empty rate series`);
      continue;
    }

    let previousTime = -Infinity;
    for (const point of points) {
      if (
        !Number.isFinite(point?.time) ||
        !validRate(point?.rate)
      ) {
        errors.push(`${key}: invalid rate point`);
        break;
      }
      if (point.time < previousTime) {
        errors.push(`${key}: rate points must be time ordered`);
        break;
      }
      if (point.time === previousTime) {
        errors.push(`${key}: duplicate timestamp`);
        break;
      }
      previousTime = point.time;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

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
  if (inverse != null) return 1 / inverse;

  const quoteToUsd = quote === 'USD'
    ? 1
    : rateAt(series[normalizeSymbol(quote + 'USD')], timestamp, maxAgeMs) ??
      (() => {
        const usdQuote = rateAt(series[normalizeSymbol('USD' + quote)], timestamp, maxAgeMs);
        return usdQuote != null ? 1 / usdQuote : null;
      })();

  const accountToUsd = account === 'USD'
    ? 1
    : rateAt(series[normalizeSymbol(account + 'USD')], timestamp, maxAgeMs) ??
      (() => {
        const usdAccount = rateAt(series[normalizeSymbol('USD' + account)], timestamp, maxAgeMs);
        return usdAccount != null ? 1 / usdAccount : null;
      })();

  if (quoteToUsd != null && accountToUsd != null && accountToUsd > 0) {
    return quoteToUsd / accountToUsd;
  }

  return null;
}
