/**
 * PORTFOLIO HEAT MANAGER
 * يحسب إجمالي المخاطرة على كل الصفقات المفتوحة
 * ويمنع فتح صفقة جديدة إذا تجاوزت نسبة معينة
 *
 * مثال: 4 صفقات مفتوحة × 1% مخاطرة = 4% heat
 * إذا الحد الأقصى 3% → يُرفض الدخول
 */
import { Trade, SystemConfig } from '../types/trading.types';
import { getSymbolSpec }       from '../config/symbolConfig';
import { Logger }              from '../utils/Logger';

export interface HeatResult {
  allowed:       boolean;
  currentHeat:   number;   // 0–1 (% of account at risk)
  maxHeat:       number;
  addedRisk:     number;   // risk from new trade
  reason:        string;
}

export class PortfolioHeat {
  private logger = new Logger('PortfolioHeat');

  constructor(private config: SystemConfig) {}

  /**
   * Check if opening a new trade would exceed portfolio heat limit.
   * @param openTrades  Current open trades
   * @param newVolume   Volume of proposed new trade
   * @param newSL       SL distance of proposed new trade
   * @param newEntry    Entry price
   * @param newSymbol   Symbol
   * @param equity      Current equity
   */
  check(
    openTrades: Trade[],
    newVolume:  number,
    newEntry:   number,
    newSL:      number,
    newSymbol:  string,
    equity:     number,
  ): HeatResult {
    const maxHeat = this.config.maxPortfolioHeat ?? 0.06; // default 6%

    // Current heat from open trades
    let currentHeat = 0;
    for (const t of openTrades) {
      const spec    = getSymbolSpec(t.symbol);
      const slDist  = Math.abs(t.entry - t.sl);
      const risk    = slDist * t.volume * spec.contractSize;
      currentHeat  += equity > 0 ? risk / equity : 0;
    }

    // Heat from new trade
    const spec      = getSymbolSpec(newSymbol);
    const slDist    = Math.abs(newEntry - newSL);
    const addedRisk = slDist * newVolume * spec.contractSize;
    const addedHeat = equity > 0 ? addedRisk / equity : 0;

    const totalHeat = currentHeat + addedHeat;

    if (totalHeat > maxHeat) {
      const reason = `Portfolio heat ${(totalHeat*100).toFixed(1)}% > max ${(maxHeat*100).toFixed(1)}%`;
      this.logger.warn(reason);
      return { allowed: false, currentHeat, maxHeat, addedRisk: addedHeat, reason };
    }

    return {
      allowed:     true,
      currentHeat,
      maxHeat,
      addedRisk:   addedHeat,
      reason:      `Heat OK: ${(totalHeat*100).toFixed(1)}% / ${(maxHeat*100).toFixed(1)}%`,
    };
  }
}
