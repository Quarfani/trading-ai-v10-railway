/**
 * PORTFOLIO HEAT MANAGER
 *
 * Uses the same market/contract economics and account-currency conversion as
 * the exposure guard. Missing conversion is fail-closed instead of silently
 * treating quote-currency risk as account-currency risk.
 */
import { Trade, SystemConfig } from '../types/trading.types';
import { Timeframe } from '../market/market.types';
import { getBrokerMarketDefinition, getMarketDefinition } from '../market/MarketCatalog';
import { resolveQuoteToAccount } from '../market/CurrencyConverter';
import { Logger } from '../utils/Logger';

export interface HeatResult {
  allowed: boolean;
  currentHeat: number;
  maxHeat: number;
  addedRisk: number;
  reason: string;
}

function stopRisk(
  symbol: string,
  entry: number,
  sl: number,
  volume: number,
  accountCurrency: string,
  prices: Record<string, number>,
  requireBrokerContract = false,
  timeframe: import('../market/market.types').Timeframe = 'H1',
): number | null {
  const market = requireBrokerContract
    ? getBrokerMarketDefinition(symbol, timeframe)
    : getMarketDefinition(symbol, timeframe);
  if (!market) return null;

  const quoteToAccount = resolveQuoteToAccount(
    market.quoteCurrency,
    accountCurrency,
    prices,
  );
  if (quoteToAccount == null) return null;

  const risk =
    Math.abs(entry - sl) *
    volume *
    market.economics.contractSize *
    quoteToAccount;

  return Number.isFinite(risk) && risk >= 0 ? risk : null;
}

export class PortfolioHeat {
  private logger = new Logger('PortfolioHeat');

  constructor(private config: SystemConfig) {}

  check(
    openTrades: Trade[],
    newVolume: number,
    newEntry: number,
    newSL: number,
    newSymbol: string,
    equity: number,
    prices: Record<string, number> = {},
    newTimeframe: Timeframe = 'H1',
  ): HeatResult {
    const maxHeat = this.config.maxPortfolioHeat ?? 0.06;
    const accountCurrency = this.config.accountCurrency ?? 'USD';

    if (!Number.isFinite(maxHeat) || maxHeat <= 0) {
      return {
        allowed: false,
        currentHeat: 0,
        maxHeat: Number.isFinite(maxHeat) ? maxHeat : 0,
        addedRisk: 0,
        reason: 'MAX_PORTFOLIO_HEAT must be a finite positive number',
      };
    }

    if (
      !Number.isFinite(newVolume) ||
      newVolume <= 0 ||
      !Number.isFinite(newEntry) ||
      newEntry <= 0 ||
      !Number.isFinite(newSL) ||
      newSL <= 0 ||
      !newSymbol?.trim()
    ) {
      return {
        allowed: false,
        currentHeat: 0,
        maxHeat,
        addedRisk: 0,
        reason: 'Invalid proposed position for portfolio heat',
      };
    }

    if (!Number.isFinite(equity) || equity <= 0) {
      return {
        allowed: false,
        currentHeat: 0,
        maxHeat,
        addedRisk: 0,
        reason: 'Equity unavailable for portfolio heat',
      };
    }

    let currentRisk = 0;

    for (const trade of openTrades) {
      const risk = stopRisk(
        trade.symbol,
        trade.entry,
        trade.sl,
        trade.volume,
        accountCurrency,
        prices,
        this.config.mode === 'mt5',
        trade.timeframe ?? 'H1',
      );

      if (risk == null) {
        return {
          allowed: false,
          currentHeat: 0,
          maxHeat,
          addedRisk: 0,
          reason:
            `Cannot calculate account-currency stop risk for ${trade.symbol}`,
        };
      }

      currentRisk += risk;
    }

    const addedRiskAbsolute = stopRisk(
      newSymbol,
      newEntry,
      newSL,
      newVolume,
      accountCurrency,
      prices,
      this.config.mode === 'mt5',
      newTimeframe,
    );

    if (addedRiskAbsolute == null) {
      return {
        allowed: false,
        currentHeat: currentRisk / equity,
        maxHeat,
        addedRisk: 0,
        reason:
          `Cannot calculate account-currency stop risk for ${newSymbol}`,
      };
    }

    const currentHeat = currentRisk / equity;
    const addedHeat = addedRiskAbsolute / equity;
    const totalHeat = currentHeat + addedHeat;

    if (totalHeat > maxHeat) {
      const reason =
        `Portfolio heat ${(totalHeat * 100).toFixed(2)}% > max ${(maxHeat * 100).toFixed(2)}%`;
      this.logger.warn(reason);
      return {
        allowed: false,
        currentHeat,
        maxHeat,
        addedRisk: addedHeat,
        reason,
      };
    }

    return {
      allowed: true,
      currentHeat,
      maxHeat,
      addedRisk: addedHeat,
      reason:
        `Heat OK: ${(totalHeat * 100).toFixed(2)}% / ${(maxHeat * 100).toFixed(2)}%`,
    };
  }
}
