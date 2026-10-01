/**
 * POSITION SIZER — v7.0
 * ══════════════════════════════════════════════════════════════════════════
 * الإصلاحات والتحسينات:
 *
 * [FIX-1] Minimum History Guard:
 *   إذا trades < 15 على الرمز نفسه → استخدم global stats من آخر 60 يوم
 *   بدلاً من الرجوع للإعدادات الافتراضية فقط
 *
 * [FIX-2] R:R Multiplier:
 *   إذا R:R الإشارة > 3.0 → يزيد الحجم بنسبة 10%  (bonus)
 *   إذا R:R < 1.5         → يقلل الحجم بنسبة 20%  (penalty)
 *   هذا يحفز الاستراتيجيات على رفع R:R
 *
 * [FIX-3] Max Single Trade Risk = 2%:
 *   يضمن أن لا صفقة واحدة تخاطر بأكثر من 2% من equity
 *   (بغض النظر عن Kelly أو Quality)
 *
 * [FIX-4] Quality floor:
 *   إذا quality < 40 → حجم × 0.5 (عقوبة صارمة للإشارات الضعيفة)
 * ══════════════════════════════════════════════════════════════════════════
 */
import { SystemConfig, Side, Timeframe } from '../types/trading.types';
import { DatabaseManager }      from '../database/DatabaseManager';
import { getMarketDefinition }  from '../market/MarketCatalog';
import { resolveQuoteToAccount } from '../market/CurrencyConverter';
import { KellyPositionSizer, SymbolTradeStats } from './KellyPositionSizer';
import { DrawdownScaler }       from './DrawdownScaler';
import { Logger }               from '../utils/Logger';

const MAX_RISK_PER_TRADE = 0.02; // [FIX-3] Hard cap: 2% of equity per trade

export class PositionSizer {
  private logger   = new Logger('PositionSizer');
  private kelly    = new KellyPositionSizer();
  private ddScaler: DrawdownScaler;

  constructor(private config: SystemConfig, private db: DatabaseManager) {
    this.ddScaler = new DrawdownScaler(db, config.accountBalance, config.mode !== 'paper');
  }

  size(
    symbol:         string,
    side:           Side,
    entry:          number,
    sl:             number,
    qualityScore  = 50,
    currentEquity?: number,
    tp?:            number,
    livePrices:     Record<string, number> = {},
    timeframe:      Timeframe = 'H1',
  ): number {
    const equity = currentEquity ?? this.config.accountBalance;

    const market = getMarketDefinition(symbol);
    if (!market) {
      this.logger.warn(`[${symbol}] No canonical market definition — sizing blocked`);
      return 0;
    }
    if (
      market.supportedTimeframes &&
      !market.supportedTimeframes.includes(timeframe)
    ) {
      this.logger.warn(
        `[${symbol}/${timeframe}] Broker market does not support this timeframe — sizing blocked`,
      );
      return 0;
    }
    const quoteToAccount = resolveQuoteToAccount(
      market.quoteCurrency,
      this.config.accountCurrency ?? 'USD',
      livePrices,
    );
    if (quoteToAccount == null) {
      this.logger.warn(`[${symbol}] Cannot convert ${market.quoteCurrency} to ${this.config.accountCurrency ?? 'USD'} — sizing blocked`);
      return 0;
    }

    // ── 1. Drawdown check ─────────────────────────────────────────────
    const ddStatus = this.ddScaler.getStatus(equity);
    if (ddStatus.level === 'STOP') {
      this.logger.warn(`DrawdownScaler: STOP (DD=${(ddStatus.drawdownPct * 100).toFixed(1)}%)`);
      return 0;
    }

    // ── 2. [FIX-1] Stats with global fallback ─────────────────────────
    const stats = this.getSymbolStatsWithFallback(symbol);

    // ── 3. Kelly sizing ───────────────────────────────────────────────
    const { volume: kellyVolume } = this.kelly.size(
      symbol,
      side,
      entry,
      sl,
      this.config,
      stats,
      qualityScore,
      equity,
      quoteToAccount,
      timeframe,
      market.economics,
    );

    // ── 4. Drawdown scale ─────────────────────────────────────────────
    let vol = kellyVolume * ddStatus.volumeScale;

    // ── 5. [FIX-4] Quality floor ──────────────────────────────────────
    if (qualityScore < 40) vol *= 0.5;

    // ── 6. [FIX-2] R:R Multiplier ────────────────────────────────────
    if (tp !== undefined) {
      const slDist = Math.abs(entry - sl);
      const tpDist = Math.abs(tp - entry);
      const rr     = slDist > 0 ? tpDist / slDist : 0;
      if (rr > 3.0) vol *= 1.10;
      else if (rr < 1.5) vol *= 0.80;
    }

    // ── 7. Absolute risk cap ───────────────────────────────────────────
    // Monetary risk = stop distance × contract value per unit.
    // The previous implementation multiplied by pipValue and then divided
    // by lotSize, which could make the 2% cap orders of magnitude too large.
    const slDistance = Math.abs(entry - sl);
    const riskPerUnit = slDistance * market.economics.contractSize * quoteToAccount;
    const maxVolByRisk = riskPerUnit > 0
      ? (equity * MAX_RISK_PER_TRADE) / riskPerUnit
      : 0;
    vol = Math.min(vol, maxVolByRisk, market.economics.maxVolume);

    // ── 8. Broker/static market constraints ────────────────────────────
    if (!(vol > 0) || !Number.isFinite(vol)) return 0;
    const steps = Math.floor(vol / market.economics.volumeStep + 1e-12);
    vol = +(steps * market.economics.volumeStep).toFixed(8);
    if (vol < market.economics.minVolume) return 0;

    this.logger.debug(
      `[${symbol}] kelly=${kellyVolume.toFixed(4)} dd=${ddStatus.volumeScale.toFixed(2)} ` +
      `q=${qualityScore} final=${vol} equity=${equity.toFixed(2)}`
    );

    return vol;
  }

  // ─── [FIX-1] Stats with global fallback ──────────────────────────────────

  private getSymbolStatsWithFallback(symbol: string): SymbolTradeStats | undefined {
    try {
      // First: symbol-specific last 30 days
      const cutoff30 = Date.now() - 30 * 24 * 3_600_000;
      const row = this.db.raw().prepare(`
        SELECT COUNT(*) trades,
               SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) wins,
               COALESCE(AVG(CASE WHEN profit > 0 THEN profit END), 0) avgWin,
               COALESCE(ABS(AVG(CASE WHEN profit <= 0 THEN profit END)), 1) avgLoss
        FROM trades WHERE status='closed' AND symbol=? AND openedAt > ?
      `).get(symbol, cutoff30) as { trades: number; wins: number; avgWin: number; avgLoss: number };

      if (row && row.trades >= 15) {
        return {
          trades:  row.trades,
          winRate: row.wins / row.trades,
          avgWin:  row.avgWin,
          avgLoss: row.avgLoss,
        };
      }

      // Fallback: global stats last 60 days
      const cutoff60 = Date.now() - 60 * 24 * 3_600_000;
      const global = this.db.raw().prepare(`
        SELECT COUNT(*) trades,
               SUM(CASE WHEN profit > 0 THEN 1 ELSE 0 END) wins,
               COALESCE(AVG(CASE WHEN profit > 0 THEN profit END), 0) avgWin,
               COALESCE(ABS(AVG(CASE WHEN profit <= 0 THEN profit END)), 1) avgLoss
        FROM trades WHERE status='closed' AND openedAt > ?
      `).get(cutoff60) as { trades: number; wins: number; avgWin: number; avgLoss: number };

      if (global && global.trades >= 20) {
        this.logger.debug(`[${symbol}] Using global stats fallback (trades=${global.trades})`);
        return {
          trades:  global.trades,
          winRate: global.wins / global.trades,
          avgWin:  global.avgWin,
          avgLoss: global.avgLoss,
        };
      }
    } catch (e) {
      if (this.config.mode !== 'paper') throw new Error(`Position-sizing statistics unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }

    return undefined; // Kelly will use defaults only when explicitly allowed in paper mode
  }

  /** Re-apply the absolute risk cap after any downstream sizing modifiers. */
  capToAbsoluteRisk(
    symbol: string,
    entry: number,
    sl: number,
    volume: number,
    equity: number,
    livePrices: Record<string, number> = {},
    timeframe: Timeframe = 'H1',
  ): number {
    if (!(equity > 0) || !(volume > 0) || !Number.isFinite(volume)) return 0;
    const market = getMarketDefinition(symbol);
    if (!market) return 0;
    if (
      market.supportedTimeframes &&
      !market.supportedTimeframes.includes(timeframe)
    ) return 0;
    const quoteToAccount = resolveQuoteToAccount(
      market.quoteCurrency,
      this.config.accountCurrency ?? 'USD',
      livePrices,
    );
    if (quoteToAccount == null) return 0;
    const riskPerUnit = Math.abs(entry - sl) * market.economics.contractSize * quoteToAccount;
    if (!(riskPerUnit > 0)) return 0;
    const maxVolume = (equity * MAX_RISK_PER_TRADE) / riskPerUnit;
    const capped = Math.min(volume, maxVolume, market.economics.maxVolume);
    const steps = Math.floor(capped / market.economics.volumeStep + 1e-12);
    const rounded = +(steps * market.economics.volumeStep).toFixed(8);
    return rounded >= market.economics.minVolume ? rounded : 0;
  }

  getDrawdownStatus(equity: number) { return this.ddScaler.getStatus(equity); }
}
