/**
 * CROSS-ASSET EXPOSURE / LEVERAGE GUARD
 *
 * Gross exposure is measured in account currency and compared with equity.
 * Conversion rates are explicit inputs; missing conversions fail closed.
 */
import { Trade } from '../types/trading.types';
import { Timeframe } from '../market/market.types';
import { getBrokerMarketDefinition, getMarketDefinition } from '../market/MarketCatalog';
import { resolveQuoteToAccount } from '../market/CurrencyConverter';

export interface ExposureSnapshot {
  currentExposure: number;
  addedExposure: number;
  totalExposure: number;
  currentLeverage: number;
  resultingLeverage: number;
  maxExposure: number;
  maxLeverage: number;
}

export interface ExposureCheck {
  allowed: boolean;
  snapshot?: ExposureSnapshot;
  reason: string;
  blockedSymbol?: string;
}

interface PositionLike {
  symbol: string;
  volume: number;
  entry: number;
  timeframe?: Timeframe;
}

function notional(
  position: PositionLike,
  prices: Record<string, number>,
  accountCurrency: string,
  requireBrokerContract = false,
  requireMarkPrice = false,
): { ok: true; value: number } | { ok: false; reason: string } {
  const market = requireBrokerContract
    ? getBrokerMarketDefinition(position.symbol, position.timeframe ?? 'H1')
    : getMarketDefinition(position.symbol, position.timeframe ?? 'H1');
  if (!market) {
    return {
      ok: false,
      reason: `No market definition for ${position.symbol}`,
    };
  }

  const quoteToAccount = resolveQuoteToAccount(
    market.quoteCurrency,
    accountCurrency,
    prices,
  );

  if (quoteToAccount == null) {
    return {
      ok: false,
      reason:
        `Cannot convert ${market.quoteCurrency} -> ${accountCurrency} for ${position.symbol}`,
    };
  }

  const markPrice = requireMarkPrice
    ? Number(prices[position.symbol])
    : Number(position.entry);

  if (!(markPrice > 0) || !Number.isFinite(markPrice)) {
    return {
      ok: false,
      reason: `Current mark price unavailable for ${position.symbol}`,
    };
  }

  const value =
    markPrice *
    Number(position.volume) *
    Number(market.economics.contractSize) *
    quoteToAccount;

  if (!Number.isFinite(value) || value < 0) {
    return {
      ok: false,
      reason: `Invalid notional for ${position.symbol}`,
    };
  }

  return { ok: true, value };
}

export function checkExposureAndLeverage(
  openTrades: Trade[],
  newPosition: PositionLike,
  equity: number,
  accountCurrency: string,
  maxExposure: number,
  maxLeverage: number,
  prices: Record<string, number> = {},
  requireBrokerContract = false,
): ExposureCheck {
  if (!Number.isFinite(equity) || equity <= 0) {
    return {
      allowed: false,
      reason: 'Positive equity is required for exposure/leverage checks',
    };
  }

  if (!Number.isFinite(maxExposure) || maxExposure <= 0) {
    return {
      allowed: false,
      reason: 'MAX_EXPOSURE must be > 0',
    };
  }

  if (!Number.isFinite(maxLeverage) || maxLeverage <= 0) {
    return {
      allowed: false,
      reason: 'MAX_LEVERAGE must be > 0',
    };
  }

  let currentExposure = 0;

  for (const trade of openTrades) {
    const result = notional(
      trade,
      prices,
      accountCurrency,
      requireBrokerContract,
      true,
    );
    if (result.ok === false) {
      return {
        allowed: false,
        reason: result.reason,
        blockedSymbol: trade.symbol,
      };
    }
    currentExposure += result.value;
  }

  const added = notional(
    newPosition,
    prices,
    accountCurrency,
    requireBrokerContract,
    false,
  );
  if (added.ok === false) {
    return {
      allowed: false,
      reason: added.reason,
      blockedSymbol: newPosition.symbol,
    };
  }

  const totalExposure = currentExposure + added.value;
  const currentLeverage = currentExposure / equity;
  const resultingLeverage = totalExposure / equity;

  const snapshot: ExposureSnapshot = {
    currentExposure,
    addedExposure: added.value,
    totalExposure,
    currentLeverage,
    resultingLeverage,
    maxExposure,
    maxLeverage,
  };

  if (resultingLeverage > maxLeverage) {
    return {
      allowed: false,
      snapshot,
      blockedSymbol: newPosition.symbol,
      reason:
        `Gross leverage ${resultingLeverage.toFixed(3)}x > max ${maxLeverage.toFixed(3)}x`,
    };
  }

  if (resultingLeverage > maxExposure) {
    return {
      allowed: false,
      snapshot,
      blockedSymbol: newPosition.symbol,
      reason:
        `Gross exposure ${resultingLeverage.toFixed(3)}x > max ${maxExposure.toFixed(3)}x`,
    };
  }

  return {
    allowed: true,
    snapshot,
    reason:
      `Exposure OK: ${resultingLeverage.toFixed(3)}x / max ${Math.min(maxExposure, maxLeverage).toFixed(3)}x`,
  };
}
