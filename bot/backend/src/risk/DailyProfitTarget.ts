import { DatabaseManager } from '../database/DatabaseManager';
import { SystemConfig } from '../types/trading.types';
import { TelegramBot } from '../notifications/TelegramBot';
import { Logger } from '../utils/Logger';

export class DailyProfitTarget {
  private logger = new Logger('DailyProfitTarget');
  private notified = '';

  constructor(
    private config: SystemConfig,
    private db: DatabaseManager,
    private telegram: TelegramBot,
  ) {}

  reached(currentEquity?: number): boolean {
    const today = new Date().toISOString().slice(0, 10);
    let gainPct: number;

    if (
      this.config.mode !== 'paper' &&
      Number.isFinite(Number(currentEquity)) &&
      Number(currentEquity) > 0
    ) {
      const denominator = this.resolveDailyStartEquity(Number(currentEquity));
      if (!(denominator > 0) || !Number.isFinite(denominator)) return true;

      const dailyChange = Number(currentEquity) - denominator;
      if (!Number.isFinite(dailyChange)) return true;
      gainPct = dailyChange / denominator;
    } else {
      const stats = this.db.getTodayStats();
      const since = Date.parse(`${today}T00:00:00.000Z`);
      const partial = this.db.getOpenPartialRealizedPnlSince(since);
      const realized = Number(stats?.pnl ?? 0) + partial;
      if (!(this.config.accountBalance > 0) || !Number.isFinite(realized)) {
        return false;
      }
      gainPct = realized / this.config.accountBalance;
    }

    const targetPct = Number(this.config.dailyProfitTarget);
    if (!Number.isFinite(targetPct) || targetPct < 0) {
      return true;
    }
    // A zero target is an explicit "disabled" setting.
    if (targetPct === 0) return false;
    const hit = gainPct >= targetPct;
    if (hit && this.notified !== today) {
      this.notified = today;
      this.telegram.sendMessage(
        `🎯 <b>DAILY TARGET REACHED</b>\nالربح اليومي: ${(gainPct * 100).toFixed(2)}%\nيتم إيقاف التداول حتى الغد للحفاظ على الأرباح.`,
      ).catch(() => {});
    }

    return hit;
  }

  private resolveDailyStartEquity(currentEquity: number): number {
    const today = new Date().toISOString().slice(0, 10);
    const account = String(this.config.accountName ?? 'default')
      .replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `daily_start_equity:${account}:${today}`;

    const raw = this.db.getSetting(key);
    if (raw != null && String(raw).trim() !== '') {
      const existing = Number(raw);
      if (Number.isFinite(existing) && existing > 0) return existing;
      this.logger.error(`Invalid persisted daily start equity for ${key} — trading blocked`);
      return NaN;
    }

    if (!(currentEquity > 0) || !Number.isFinite(currentEquity)) return NaN;

    this.db.setSetting(key, currentEquity.toFixed(8));
    return currentEquity;
  }
}
