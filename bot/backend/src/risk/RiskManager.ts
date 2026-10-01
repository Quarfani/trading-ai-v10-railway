/**
 * RISK MANAGER — v7.2
 * Central risk gate. Economic exposure/leverage now use canonical market
 * definitions and explicit account-currency conversion.
 */
import {
  Signal,
  Trade,
  SystemConfig,
  RiskResult,
  Mode,
  Candle,
} from '../types/trading.types';
import { CircuitBreaker } from './CircuitBreaker';
import { DailyLossGuard } from './DailyLossGuard';
import { DailyProfitTarget } from './DailyProfitTarget';
import { PositionSizer } from './PositionSizer';
import { SpreadFilter } from './SpreadFilter';
import { NewsFilter } from './NewsFilter';
import { CorrelationFilter } from './CorrelationFilter';
import { SessionFilter } from './SessionFilter';
import { PortfolioHeat } from './PortfolioHeat';
import { checkExposureAndLeverage } from './ExposureGuard';
import { EmergencyStop } from '../integration/EmergencyStop';
import { DatabaseManager } from '../database/DatabaseManager';
import { TelegramBot } from '../notifications/TelegramBot';
import { Logger } from '../utils/Logger';
import { getSymbolSpec } from '../config/symbolConfig';

export function validateRiskReward(
  signal: { price: number; sl: number; tp: number },
  minRR = 1.5,
): { valid: boolean; rr: number; reason: string } {
  const risk = Math.abs(signal.price - signal.sl);
  const reward = Math.abs(signal.tp - signal.price);

  if (!Number.isFinite(risk) || risk <= 0) {
    return { valid: false, rr: 0, reason: 'Invalid SL distance' };
  }

  if (!Number.isFinite(reward) || reward <= 0) {
    return { valid: false, rr: 0, reason: 'Invalid TP distance' };
  }

  const rr = reward / risk;

  if (!Number.isFinite(rr)) {
    return { valid: false, rr: 0, reason: 'Invalid R:R' };
  }

  if (rr < minRR) {
    return {
      valid: false,
      rr,
      reason: `R:R ${rr.toFixed(3)} < minimum ${minRR.toFixed(2)}`,
    };
  }

  return {
    valid: true,
    rr,
    reason: `R:R ${rr.toFixed(3)} OK`,
  };
}

export class RiskManager {
  private logger = new Logger('RiskManager');
  private breaker: CircuitBreaker;
  private lossGuard: DailyLossGuard;
  private profitTarget: DailyProfitTarget;
  private sizer: PositionSizer;
  private spread: SpreadFilter;
  private news: NewsFilter;
  private correlation: CorrelationFilter;
  private session: SessionFilter;
  private heat: PortfolioHeat;
  private mode: Mode;

  constructor(
    private config: SystemConfig,
    private db: DatabaseManager,
    private telegram: TelegramBot,
    private emergency: EmergencyStop,
  ) {
    this.mode = config.mode;
    this.breaker = new CircuitBreaker(
      config.consecutiveLossLimit,
      config.cooldownMinutes * 60_000,
      telegram,
    );
    this.lossGuard = new DailyLossGuard(config, db, telegram);
    this.profitTarget = new DailyProfitTarget(config, db, telegram);
    this.sizer = new PositionSizer(config, db);
    this.spread = new SpreadFilter();
    this.news = new NewsFilter();
    this.correlation = new CorrelationFilter();
    this.session = new SessionFilter();
    this.heat = new PortfolioHeat(config);
  }

  async check(
    signal: Signal,
    openTrades: Trade[],
    ticker?: { bid: number; ask: number },
    equity?: number,
    qualityScore = 50,
    livePrices: Record<string, number> = {},
    candleMap?: Record<string, Candle[]>,
  ): Promise<RiskResult> {
    const reasons: string[] = [];

    if (this.emergency.isActive()) {
      return this.block('emergency_stop', [
        `Emergency: ${this.emergency.getReason()}`,
      ]);
    }

    if (!this.breaker.canTrade()) {
      return this.block('circuit_breaker', [
        this.breaker.getStatus(),
      ]);
    }

    const minConf = this.config.minConfidence ?? 0.55;
    if (signal.confidence < minConf) {
      return this.block('low_confidence', [
        `Confidence ${signal.confidence.toFixed(3)} < ${minConf}`,
      ]);
    }

    const rrCheck = validateRiskReward(
      signal,
      this.config.minRR ?? 1.5,
    );

    if (!rrCheck.valid) {
      return this.block('min_rr', [rrCheck.reason]);
    }

    reasons.push(
      `[R:R] ${rrCheck.rr.toFixed(2)} >= ${(
        this.config.minRR ?? 1.5
      ).toFixed(2)}`,
    );

    const price = signal.price;
    const sl = signal.sl;
    const tp = signal.tp;

    if (
      ![price, sl, tp].every(Number.isFinite) ||
      !(price > 0)
    ) {
      return this.block('invalid_prices', [
        'Signal price/SL/TP must be finite and price must be > 0',
      ]);
    }

    if (signal.side === 'BUY') {
      if (sl >= price) {
        return this.block('invalid_sl', [
          `BUY: SL (${sl.toFixed(5)}) must be BELOW entry (${price.toFixed(5)})`,
        ]);
      }
      if (tp <= price) {
        return this.block('invalid_tp', [
          `BUY: TP (${tp.toFixed(5)}) must be ABOVE entry (${price.toFixed(5)})`,
        ]);
      }
    } else {
      if (sl <= price) {
        return this.block('invalid_sl', [
          `SELL: SL (${sl.toFixed(5)}) must be ABOVE entry (${price.toFixed(5)})`,
        ]);
      }
      if (tp >= price) {
        return this.block('invalid_tp', [
          `SELL: TP (${tp.toFixed(5)}) must be BELOW entry (${price.toFixed(5)})`,
        ]);
      }
    }

    reasons.push('SL/TP direction valid');

    const slDist = Math.abs(price - sl);
    const tpDist = Math.abs(tp - price);
    const rr = slDist > 0 ? tpDist / slDist : 0;

    if (rr < (this.config.minRR ?? 1.5)) {
      return this.block('low_rr', [
        `R:R ${rr.toFixed(2)} < min ${this.config.minRR ?? 1.5}`,
      ]);
    }

    reasons.push(`R:R ${rr.toFixed(2)}`);

    const slPct = slDist / price;
    if (slPct > 0.10) {
      return this.block('sl_too_far', [
        `SL is ${(slPct * 100).toFixed(1)}% from entry — check signal`,
      ]);
    }

    if (
      this.mode !== 'paper' &&
      !(
        equity != null &&
        equity > 0 &&
        Number.isFinite(equity)
      )
    ) {
      return this.block('equity_unavailable', [
        'Live account equity is unavailable; trading is fail-closed',
      ]);
    }

    if (!(await this.lossGuard.canTrade(livePrices))) {
      return this.block('daily_loss_limit', [
        'Daily loss limit reached',
      ]);
    }

    const weeklyLimit = this.config.maxWeeklyLoss ?? 0.05;
    try {
      const since = Date.now() - 7 * 24 * 60 * 60_000;
      const row = this.db.raw().prepare(
        `SELECT COALESCE(SUM(profit),0) AS pnl FROM trades WHERE status='closed' AND closedAt > ?`,
      ).get(since) as { pnl?: number } | undefined;

      const weeklyPnl = Number(row?.pnl ?? 0);
      if (
        weeklyPnl < 0 &&
        Math.abs(weeklyPnl) >=
          currentEquityForRisk(
            this.mode,
            equity,
            this.config.accountBalance,
          ) * weeklyLimit
      ) {
        return this.block('weekly_loss_limit', [
          `7-day loss ${Math.abs(weeklyPnl).toFixed(2)} >= ${(
            weeklyLimit * 100
          ).toFixed(1)}%`,
        ]);
      }
    } catch (e) {
      if (this.mode !== 'paper') {
        return this.block(
          'weekly_loss_state_unavailable',
          [e instanceof Error ? e.message : String(e)],
        );
      }
    }

    const equityForRisk = currentEquityForRisk(
      this.mode,
      equity,
      this.config.accountBalance,
    );

    const ddStatus = this.sizer.getDrawdownStatus(equityForRisk);
    const maxDrawdown = this.config.maxDrawdown ?? 0.10;

    if (ddStatus.drawdownPct >= maxDrawdown) {
      return this.block('max_drawdown', [
        `Drawdown ${(ddStatus.drawdownPct * 100).toFixed(2)}% >= ${(
          maxDrawdown * 100
        ).toFixed(2)}%`,
      ]);
    }

    if (this.profitTarget.reached()) {
      return this.block('daily_profit_target', [
        'Daily profit target reached',
      ]);
    }

    const currentOpen = this.db.getOpenTrades().length;
    if (currentOpen >= this.config.maxOpenTrades) {
      return this.block('max_open_trades', [
        `${currentOpen}/${this.config.maxOpenTrades} trades open`,
      ]);
    }

    reasons.push(
      `Open trades ${currentOpen}/${this.config.maxOpenTrades}`,
    );

    const sessionCheck = this.session.check(
      signal.source,
      signal.symbol,
      signal.timestamp,
    );

    if (!sessionCheck.allowed) {
      return this.block('session_filter', [
        sessionCheck.reason,
      ]);
    }

    reasons.push(`Session: ${sessionCheck.session}`);

    if (
      !ticker ||
      !Number.isFinite(ticker.bid) ||
      !Number.isFinite(ticker.ask) ||
      !(ticker.ask > ticker.bid)
    ) {
      return this.block('ticker_unavailable', [
        'Executable bid/ask is unavailable; spread/slippage cannot be validated',
      ]);
    }

    const sc = this.spread.check(
      signal.symbol,
      ticker.bid,
      ticker.ask,
    );

    if (!sc.ok) {
      return this.block('spread_too_wide', [
        `Spread ${sc.spreadPips.toFixed(2)} pips`,
      ]);
    }

    reasons.push(
      `Spread ${sc.spreadPips.toFixed(2)} pips`,
    );

    const maxSlip = this.config.maxSlippagePips ?? 3;
    const spec = getSymbolSpec(signal.symbol);
    const execPrice =
      signal.side === 'BUY' ? ticker.ask : ticker.bid;
    const slippagePips =
      Math.abs(price - execPrice) / spec.pip;

    if (
      !Number.isFinite(slippagePips) ||
      slippagePips > maxSlip
    ) {
      return this.block('slippage', [
        `Slippage ${Number.isFinite(slippagePips) ? slippagePips.toFixed(2) : 'NaN'} pips > max ${maxSlip}`,
      ]);
    }

    reasons.push(`Slippage ${slippagePips.toFixed(2)} pips`);

    const newsBlock = this.news.isBlocked(
      signal.symbol,
      Date.now(),
      this.config.newsFilter?.blockMediumImpact ?? false,
    );

    if (newsBlock.blocked) {
      return this.block('news_event', [
        `News: ${newsBlock.event?.title ?? signal.symbol}`,
      ]);
    }

    const corrBlock = this.correlation.isCorrelated(
      signal.symbol,
      signal.side,
      openTrades,
      candleMap,
    );

    if (corrBlock.blocked) {
      return this.block('correlation', [
        `Correlated: ${corrBlock.with} r=${corrBlock.correlation?.toFixed(2) ?? 'static'}`,
      ]);
    }

    if (this.isWeekendBlocked()) {
      return this.block('weekend', [
        'Weekend — market closed',
      ]);
    }

    const currentEquity = equityForRisk;

    if (!(currentEquity > 0)) {
      return this.block('equity_unavailable', [
        'No positive current equity available for position sizing',
      ]);
    }

    const volume = this.sizer.size(
      signal.symbol,
      signal.side,
      price,
      sl,
      qualityScore,
      currentEquity,
      tp,
    );

    if (volume <= 0) {
      const latestDd = this.sizer.getDrawdownStatus(
        currentEquity,
      );

      if (latestDd.level === 'STOP') {
        return this.block('drawdown_stop', [
          `DD ${(latestDd.drawdownPct * 100).toFixed(1)}% >= 10%`,
        ]);
      }

      return this.block('invalid_volume', [
        `Volume ${volume}`,
      ]);
    }

    const exposureCheck = checkExposureAndLeverage(
      openTrades,
      {
        symbol: signal.symbol,
        volume,
        entry: price,
      },
      currentEquity,
      this.config.accountCurrency ?? 'USD',
      this.config.maxExposure ?? 1,
      this.config.maxLeverage ?? 3,
      livePrices,
    );

    if (!exposureCheck.allowed) {
      return this.block('exposure_leverage', [
        exposureCheck.reason,
      ]);
    }

    reasons.push(
      `Exposure ${(
        (exposureCheck.snapshot?.resultingLeverage ?? 0) *
        100
      ).toFixed(2)}% of equity`,
    );

    const heatCheck = this.heat.check(
      openTrades,
      volume,
      price,
      sl,
      signal.symbol,
      currentEquity,
      livePrices,
    );

    if (!heatCheck.allowed) {
      return this.block('portfolio_heat', [
        heatCheck.reason,
      ]);
    }

    reasons.push(
      `Heat ${(heatCheck.currentHeat * 100).toFixed(1)}%`,
    );

    reasons.push(`Volume ${volume}`);
    reasons.push('All checks passed');

    return {
      passed: true,
      volume,
      blockedBy: '',
      reasons,
    };
  }

  recordClose(profit: number) {
    this.breaker.recordResult(profit);
  }

  async refreshNews() {
    await this.news.refresh();
  }

  getCircuitBreakerStatus() {
    return this.breaker.getStatus();
  }

  getSizer() {
    return this.sizer;
  }

  private block(reason: string, reasons: string[]): RiskResult {
    this.logger.info(
      `Risk blocked — ${reason}: ${reasons[0]}`,
    );
    return {
      passed: false,
      volume: 0,
      blockedBy: reason,
      reasons,
    };
  }

  private isWeekendBlocked(): boolean {
    if (this.mode !== 'mt5') return false;
    const d = new Date();
    const day = d.getUTCDay();
    const h = d.getUTCHours();
    return (
      (day === 5 && h >= 19) ||
      day === 6 ||
      (day === 0 && h < 22)
    );
  }
}

function currentEquityForRisk(
  mode: Mode,
  equity: number | undefined,
  fallback: number,
): number {
  if (
    equity != null &&
    Number.isFinite(equity) &&
    equity > 0
  ) {
    return equity;
  }

  return mode === 'paper' ? fallback : 0;
}
