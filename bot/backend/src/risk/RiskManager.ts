/**
 * RISK MANAGER — v7.2
 * [FIX CRITICAL] SL/TP direction validation:
 *   BUY:  SL must be BELOW entry, TP must be ABOVE entry
 *   SELL: SL must be ABOVE entry, TP must be BELOW entry
 *   Previously: only absolute distances were checked — an inverted
 *   signal would pass R:R check but get rejected by broker, wasting
 *   API calls and causing confusing logs.
 * [FIX CRITICAL] maxOpenTrades race condition:
 *   uses db.countOpenTrades() at check time — now also enforced by
 *   PositionTracker.hasOpenPosition() just before execution.
 */
import { Signal, Trade, SystemConfig, RiskResult, Mode, Candle } from '../types/trading.types';
import { CircuitBreaker }    from './CircuitBreaker';
import { DailyLossGuard }    from './DailyLossGuard';
import { DailyProfitTarget } from './DailyProfitTarget';
import { PositionSizer }     from './PositionSizer';
import { SpreadFilter }      from './SpreadFilter';
import { NewsFilter }        from './NewsFilter';
import { CorrelationFilter } from './CorrelationFilter';
import { SessionFilter }     from './SessionFilter';
import { PortfolioHeat }     from './PortfolioHeat';
import { EmergencyStop }     from '../integration/EmergencyStop';
import { DatabaseManager }   from '../database/DatabaseManager';
import { TelegramBot }       from '../notifications/TelegramBot';
import { Logger }            from '../utils/Logger';
import { getSymbolSpec }     from '../config/symbolConfig';

export class RiskManager {
  private logger = new Logger('RiskManager');
  private breaker:      CircuitBreaker;
  private lossGuard:    DailyLossGuard;
  private profitTarget: DailyProfitTarget;
  private sizer:        PositionSizer;
  private spread:       SpreadFilter;
  private news:         NewsFilter;
  private correlation:  CorrelationFilter;
  private session:      SessionFilter;
  private heat:         PortfolioHeat;
  private mode:         Mode;

  constructor(
    private config:    SystemConfig,
    private db:        DatabaseManager,
    private telegram:  TelegramBot,
    private emergency: EmergencyStop,
  ) {
    this.mode         = config.mode;
    this.breaker      = new CircuitBreaker(config.consecutiveLossLimit, config.cooldownMinutes * 60_000, telegram);
    this.lossGuard    = new DailyLossGuard(config, db, telegram);
    this.profitTarget = new DailyProfitTarget(config, db, telegram);
    this.sizer        = new PositionSizer(config, db);
    this.spread       = new SpreadFilter();
    this.news         = new NewsFilter();
    this.correlation  = new CorrelationFilter();
    this.session      = new SessionFilter();
    this.heat         = new PortfolioHeat(config);
  }

  async check(
    signal:       Signal,
    openTrades:   Trade[],
    ticker?:      { bid: number; ask: number },
    equity?:      number,
    qualityScore = 50,
    livePrices?:  Record<string, number>,
    candleMap?:   Record<string, Candle[]>,
  ): Promise<RiskResult> {
    const reasons: string[] = [];

    // ── 1. Emergency stop ──────────────────────────────────────────
    if (this.emergency.isActive())
      return this.block('emergency_stop', [`Emergency: ${this.emergency.getReason()}`]);

    // ── 2. Circuit breaker ─────────────────────────────────────────
    if (!this.breaker.canTrade())
      return this.block('circuit_breaker', [this.breaker.getStatus()]);

    // ── 3. Confidence gate ─────────────────────────────────────────
    const minConf = this.config.minConfidence ?? 0.55;
    if (signal.confidence < minConf)
      return this.block('low_confidence', [`Confidence ${signal.confidence.toFixed(3)} < ${minConf}`]);

    // ── 4. [FIX CRITICAL] SL/TP direction validation ───────────────
    // Prevents inverted orders from reaching the broker
    const price = signal.price;
    const sl    = signal.sl;
    const tp    = signal.tp;
    if (![price, sl, tp].every(Number.isFinite) || !(price > 0))
      return this.block('invalid_prices', ['Signal price/SL/TP must be finite and price must be > 0']);

    if (signal.side === 'BUY') {
      if (sl >= price)
        return this.block('invalid_sl', [
          `BUY: SL (${sl.toFixed(5)}) must be BELOW entry (${price.toFixed(5)})`
        ]);
      if (tp <= price)
        return this.block('invalid_tp', [
          `BUY: TP (${tp.toFixed(5)}) must be ABOVE entry (${price.toFixed(5)})`
        ]);
    } else {
      // SELL
      if (sl <= price)
        return this.block('invalid_sl', [
          `SELL: SL (${sl.toFixed(5)}) must be ABOVE entry (${price.toFixed(5)})`
        ]);
      if (tp >= price)
        return this.block('invalid_tp', [
          `SELL: TP (${tp.toFixed(5)}) must be BELOW entry (${price.toFixed(5)})`
        ]);
    }
    reasons.push('✓ SL/TP direction valid');

    // ── 5. Minimum R:R ─────────────────────────────────────────────
    const minRR   = this.config.minRR ?? 1.5;
    const slDist  = Math.abs(price - sl);
    const tpDist  = Math.abs(tp - price);
    const rr      = slDist > 0 ? tpDist / slDist : 0;
    if (rr < minRR)
      return this.block('low_rr', [`R:R ${rr.toFixed(2)} < min ${minRR}`]);
    reasons.push(`✓ R:R ${rr.toFixed(2)}`);

    // ── 6. SL distance sanity check ────────────────────────────────
    // SL should not be unrealistically far (>10% from entry — likely a bug)
    const slPct = slDist / price;
    if (slPct > 0.10)
      return this.block('sl_too_far', [
        `SL is ${(slPct*100).toFixed(1)}% from entry — check signal`
      ]);

    // ── 7. Daily loss ──────────────────────────────────────────────
    if (this.mode !== 'paper' && !(equity != null && equity > 0 && Number.isFinite(equity)))
      return this.block('equity_unavailable', ['Live account equity is unavailable; trading is fail-closed']);
    if (!(await this.lossGuard.canTrade(livePrices)))
      return this.block('daily_loss_limit', ['Daily loss limit reached']);

    // Weekly loss guard. This is intentionally fail-closed in live modes
    // because risk state must never disappear silently on a database read error.
    const weeklyLimit = this.config.maxWeeklyLoss ?? 0.05;
    try {
      const since = Date.now() - 7 * 24 * 60 * 60_000;
      const row = this.db.raw().prepare(
        `SELECT COALESCE(SUM(profit),0) AS pnl FROM trades WHERE status='closed' AND closedAt > ?`
      ).get(since) as { pnl?: number } | undefined;
      const weeklyPnl = Number(row?.pnl ?? 0);
      if (weeklyPnl < 0 && Math.abs(weeklyPnl) >= currentEquityForRisk(this.mode, equity, this.config.accountBalance) * weeklyLimit)
        return this.block('weekly_loss_limit', [`7-day loss ${Math.abs(weeklyPnl).toFixed(2)} >= ${(weeklyLimit*100).toFixed(1)}%`]);
    } catch (e) {
      if (this.mode !== 'paper')
        return this.block('weekly_loss_state_unavailable', [e instanceof Error ? e.message : String(e)]);
    }

    const equityForRisk = currentEquityForRisk(this.mode, equity, this.config.accountBalance);
    const ddStatus = this.sizer.getDrawdownStatus(equityForRisk);
    const maxDrawdown = this.config.maxDrawdown ?? 0.10;
    if (ddStatus.drawdownPct >= maxDrawdown)
      return this.block('max_drawdown', [`Drawdown ${(ddStatus.drawdownPct*100).toFixed(2)}% >= ${(maxDrawdown*100).toFixed(2)}%`]);

    // ── 8. Daily profit target ─────────────────────────────────────
    if (this.profitTarget.reached())
      return this.block('daily_profit_target', ['Daily profit target reached']);

    // ── 9. Max open trades ─────────────────────────────────────────
    // Re-query from DB for latest count (avoids race condition)
    const currentOpen = this.db.getOpenTrades().length;
    if (currentOpen >= this.config.maxOpenTrades)
      return this.block('max_open_trades', [`${currentOpen}/${this.config.maxOpenTrades} trades open`]);
    reasons.push(`✓ Open trades ${currentOpen}/${this.config.maxOpenTrades}`);

    // ── 10. Session filter ─────────────────────────────────────────
    const sessionCheck = this.session.check(signal.source, signal.symbol, signal.timestamp);
    if (!sessionCheck.allowed)
      return this.block('session_filter', [sessionCheck.reason]);
    reasons.push(`✓ Session: ${sessionCheck.session}`);

    // ── 11. Spread / slippage check ───────────────────────────────────
    if (!ticker || !Number.isFinite(ticker.bid) || !Number.isFinite(ticker.ask) || !(ticker.ask > ticker.bid))
      return this.block('ticker_unavailable', ['Executable bid/ask is unavailable; spread/slippage cannot be validated']);

    const sc = this.spread.check(signal.symbol, ticker.bid, ticker.ask);
    if (!sc.ok)
      return this.block('spread_too_wide', [`Spread ${sc.spreadPips.toFixed(2)} pips`]);
    reasons.push(`✓ Spread ${sc.spreadPips.toFixed(2)} pips`);

    const maxSlip      = this.config.maxSlippagePips ?? 3;
    const spec         = getSymbolSpec(signal.symbol);
    const execPrice    = signal.side === 'BUY' ? ticker.ask : ticker.bid;
    const slippagePips = Math.abs(price - execPrice) / spec.pip;
    if (!Number.isFinite(slippagePips) || slippagePips > maxSlip)
      return this.block('slippage', [`Slippage ${Number.isFinite(slippagePips) ? slippagePips.toFixed(2) : 'NaN'} pips > max ${maxSlip}`]);
    reasons.push(`✓ Slippage ${slippagePips.toFixed(2)} pips`);

    // ── 12. News filter ────────────────────────────────────────────
    const newsBlock = this.news.isBlocked(signal.symbol, Date.now(), this.config.newsFilter?.blockMediumImpact ?? false);
    if (newsBlock.blocked)
      return this.block('news_event', [`News: ${newsBlock.event?.title ?? signal.symbol}`]);

    // ── 13. Correlation filter ─────────────────────────────────────
    const corrBlock = this.correlation.isCorrelated(signal.symbol, signal.side, openTrades, candleMap);
    if (corrBlock.blocked)
      return this.block('correlation', [
        `Correlated: ${corrBlock.with} r=${corrBlock.correlation?.toFixed(2) ?? 'static'}`
      ]);

    // ── 14. Weekend guard ──────────────────────────────────────────
    if (this.isWeekendBlocked())
      return this.block('weekend', ['Weekend — market closed']);

    // ── 15. Position sizing ────────────────────────────────────────
    const currentEquity = equityForRisk;
    if (!(currentEquity > 0))
      return this.block('equity_unavailable', ['No positive current equity available for position sizing']);
    const volume = this.sizer.size(
      signal.symbol, signal.side, price, sl, qualityScore, currentEquity, tp
    );

    if (volume <= 0) {
      const ddStatus = this.sizer.getDrawdownStatus(currentEquity);
      if (ddStatus.level === 'STOP')
        return this.block('drawdown_stop', [`DD ${(ddStatus.drawdownPct*100).toFixed(1)}% ≥ 10%`]);
      return this.block('invalid_volume', [`Volume ${volume}`]);
    }

    // ── 16. Portfolio heat ─────────────────────────────────────────
    const heatCheck = this.heat.check(
      openTrades, volume, price, sl, signal.symbol, currentEquity
    );
    if (!heatCheck.allowed)
      return this.block('portfolio_heat', [heatCheck.reason]);
    reasons.push(`✓ Heat ${(heatCheck.currentHeat*100).toFixed(1)}%`);

    reasons.push(`✓ Volume ${volume}`);
    reasons.push('✓ All checks passed');
    return { passed: true, volume, blockedBy: '', reasons };
  }

  recordClose(profit: number) { this.breaker.recordResult(profit); }
  async refreshNews()          { await this.news.refresh(); }
  getCircuitBreakerStatus()   { return this.breaker.getStatus(); }
  getSizer()                  { return this.sizer; }

  private block(reason: string, reasons: string[]): RiskResult {
    this.logger.info(`Risk blocked — ${reason}: ${reasons[0]}`);
    return { passed: false, volume: 0, blockedBy: reason, reasons };
  }

  private isWeekendBlocked(): boolean {
    if (this.mode !== 'mt5') return false;
    const d = new Date(), day = d.getUTCDay(), h = d.getUTCHours();
    return (day === 5 && h >= 19) || day === 6 || (day === 0 && h < 22);
  }
}

function currentEquityForRisk(mode: Mode, equity: number | undefined, fallback: number): number {
  if (equity != null && Number.isFinite(equity) && equity > 0) return equity;
  return mode === 'paper' ? fallback : 0;
}
