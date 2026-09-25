/**
 * HEARTBEAT — sends a periodic status ping to Telegram
 */
import { TradingEngine } from '../core/TradingEngine';
import { TelegramBot }   from './TelegramBot';

export class Heartbeat {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private telegram: TelegramBot,
    private engine:   TradingEngine,
    private minutes:  number = 60,
  ) {}

  start() {
    if (!this.interval) {
      this.interval = setInterval(() => this.ping().catch(() => {}), this.minutes * 60_000);
    }
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  private async ping() {
    const s = this.engine.getPerformanceSummary();
    const r = this.engine.getRiskStatus();
    await this.telegram.sendMessage(
      `💓 <b>Heartbeat</b>\n` +
      `Running: ${this.engine.isActive()}\n` +
      `Risk: ${r}\n` +
      `Today: ${s?.today?.trades ?? 0} trades | W/L ${s?.today?.wins ?? 0}/${s?.today?.losses ?? 0} | P&L $${s?.today?.pnl?.toFixed(2) ?? '0.00'}`
    ).catch(() => {});
  }
}
