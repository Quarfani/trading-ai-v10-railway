/**
 * DAILY LOSS GUARD — v2.0
 * FIX BUG-C2: calcFloating() used hardcoded contractSize 100,000 for ALL symbols.
 *   XAUUSD contractSize = 100   → PnL was overstated 1,000×
 *   BTCUSDT contractSize = 1    → PnL was overstated 100,000×
 * Result: the daily loss limit tripped immediately on any open gold/crypto trade,
 * blocking all new positions even when the account was barely negative.
 *
 * Fix: use getSymbolSpec(symbol).contractSize per trade.
 */
import { DatabaseManager }        from '../database/DatabaseManager';
import { SystemConfig, Trade }    from '../types/trading.types';
import { TelegramBot }            from '../notifications/TelegramBot';
import { getSymbolSpec }          from '../config/symbolConfig';
import { Logger }                 from '../utils/Logger';

export class DailyLossGuard {
  private logger      = new Logger('LossGuard');
  private warnedToday = '';

  constructor(
    private config:   SystemConfig,
    private db:       DatabaseManager,
    private telegram: TelegramBot,
  ) {}

  /**
   * Returns false when today's total loss (realized + floating) exceeds the
   * configured maxDailyLoss percentage.
   *
   * @param currentPrices live mid-prices keyed by symbol (for floating P&L)
   */
  async canTrade(currentPrices?: Record<string, number>): Promise<boolean> {
    const stats       = this.db.getTodayStats();
    const realizedPnl = stats?.pnl ?? 0;

    const floatingPnl = this.calcFloating(currentPrices);
    const totalLoss   = realizedPnl + floatingPnl;
    const lossPct     = -totalLoss / this.config.accountBalance;

    if (lossPct >= this.config.maxDailyLoss) {
      const today = new Date().toISOString().slice(0, 10);
      if (this.warnedToday !== today) {
        this.warnedToday = today;
        const msg =
          `⚠️ <b>DAILY LOSS LIMIT HIT</b>\n` +
          `خسارة محققة: $${realizedPnl.toFixed(2)}\n` +
          `خسارة عائمة: $${floatingPnl.toFixed(2)}\n` +
          `إجمالي الخسارة: ${(lossPct * 100).toFixed(2)}% ` +
          `(الحد: ${(this.config.maxDailyLoss * 100).toFixed(1)}%)\n` +
          `تم إيقاف التداول حتى منتصف الليل UTC.`;
        this.logger.error(msg);
        await this.telegram.sendMessage(msg).catch(() => {});
      }
      return false;
    }
    return true;
  }

  /**
   * Calculate floating P&L from all open trades.
   * FIX: uses per-symbol contractSize from symbolConfig — not hardcoded 100,000.
   */
  private calcFloating(prices?: Record<string, number>): number {
    if (!prices || Object.keys(prices).length === 0) return 0;

    const open: Trade[] = this.db.getOpenTrades();
    let floating = 0;

    for (const t of open) {
      const price = prices[t.symbol];
      if (!price || !t.entry) continue;

      // FIX BUG-C2: per-symbol contractSize
      const spec        = getSymbolSpec(t.symbol);
      const priceDelta  = t.side === 'BUY'
        ? price - t.entry
        : t.entry - price;

      // P&L in account currency (USD)
      floating += priceDelta * t.volume * spec.contractSize;
    }

    return floating;
  }
}
