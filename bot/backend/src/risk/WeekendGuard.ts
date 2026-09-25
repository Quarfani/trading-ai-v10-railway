/**
 * WEEKEND GUARD
 * ═══════════════════════════════════════════════════════════════════════════
 * Fix: removed circular dependency on TradingEngine.
 * Now depends only on the minimal interfaces it actually needs.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { SystemConfig, Trade } from '../types/trading.types';
import { DatabaseManager }     from '../database/DatabaseManager';
import { ExecutionGateway }    from '../execution/ExecutionGateway';
import { TelegramBot }         from '../notifications/TelegramBot';
import { Logger }              from '../utils/Logger';

export class WeekendGuard {
  private logger = new Logger('WeekendGuard');
  private interval: NodeJS.Timeout | null = null;
  private closedThisWeek = '';

  constructor(
    private config:   SystemConfig,
    private db:       DatabaseManager,
    private exec:     ExecutionGateway,
    private telegram: TelegramBot,
  ) {}

  start() {
    if (!this.interval) {
      this.interval = setInterval(() => this.tick().catch(() => {}), 5 * 60_000);
    }
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** Used by RiskManager to block new trades near weekend */
  shouldBlock(): boolean {
    if (this.config.mode !== 'mt5') return false;
    const d   = new Date();
    const day = d.getUTCDay();
    const h   = d.getUTCHours();
    if (day === 5 && h >= 19) return true;
    if (day === 6) return true;
    if (day === 0 && h < 22) return true;
    return false;
  }

  /** Auto-close all open MT5 positions at Friday 20:30 UTC */
  private async tick() {
    if (this.config.mode !== 'mt5') return;
    const d = new Date();
    if (d.getUTCDay() !== 5 || d.getUTCHours() !== 20 || d.getUTCMinutes() < 30) return;

    const week = `${d.getUTCFullYear()}-W${Math.ceil(d.getUTCDate() / 7)}`;
    if (this.closedThisWeek === week) return;
    this.closedThisWeek = week;

    const open = this.db.getOpenTrades();
    if (!open.length) return;

    this.logger.warn(`Weekend close: ${open.length} positions`);
    let n = 0;
    for (const t of open) {
      if (!t.ticket) continue;
      const r = await this.exec.closeTrade(t);
      if (r) n++;
    }
    await this.telegram.sendMessage(
      `🏁 <b>Weekend Close</b>\nClosed ${n} position(s) before market close.`
    ).catch(() => {});
  }
}
