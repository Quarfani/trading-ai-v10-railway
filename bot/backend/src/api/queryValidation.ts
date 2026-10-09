import { isTimeframe, Timeframe } from '../market/market.types';

/**
 * Parses a numeric query parameter without allowing NaN/Infinity to reach SQL
 * limits, slicing operations, or time windows.
 */
export function boundedQueryNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = true,
): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    (typeof candidate !== 'string' && typeof candidate !== 'number') ||
    (typeof candidate === 'string' && candidate.trim() === '')
  ) {
    return fallback;
  }

  const parsed = typeof candidate === 'number' ? candidate : Number(candidate);
  if (!Number.isFinite(parsed)) return fallback;

  const bounded = Math.min(max, Math.max(min, parsed));
  return integer ? Math.trunc(bounded) : bounded;
}

/** Returns null for a supplied invalid timeframe; undefined means use default. */
export function parseTimeframeQuery(
  value: unknown,
  fallback: Timeframe = 'H1',
): Timeframe | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined || candidate === null) return fallback;
  if (typeof candidate !== 'string') return null;

  const normalized = candidate.trim().toUpperCase();
  return isTimeframe(normalized) ? normalized : null;
}
