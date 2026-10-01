/**
 * PORTFOLIO HEAT MANAGER
 *
 * Uses the same market/contract economics and account-currency conversion as
 * the exposure guard. Missing conversion is fail-closed instead of silently
 * treating quote-currency risk as account-currency risk.
 */
import { Trade } from '../types/trading.types';
import { SystemConfig } from '../types/trading.types';
import { getMarketDefinition } from '../market/MarketCatalog';
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
): number | null {
  const market = getMarketDefinition(symbol);
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
  ): HeatResult {
    const maxHeat = this.config.maxPortfolioHeat ?? 0.06;
    const accountCurrency = this.config.accountCurrency ?? 'USD';

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
