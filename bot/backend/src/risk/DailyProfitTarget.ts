import { DatabaseManager } from '../database/DatabaseManager';
import { SystemConfig } from '../types/trading.types';
import { TelegramBot } from '../notifications/TelegramBot';

export class DailyProfitTarget {
  private notified = '';
  constructor(private config: SystemConfig, private db: DatabaseManager, private telegram: TelegramBot) {}

  reached(): boolean {
    const stats = this.db.getTodayStats();
    if (!stats) return false;
    const gainPct = stats.pnl / this.config.accountBalance;
    const hit = gainPct >= this.config.dailyProfitTarget;
    if (hit) {
      const today = new Date().toISOString().slice(0, 10);
      if (this.notified !== today) {
        this.notified = today;
        this.telegram.sendMessage(
          `🎯 <b>DAILY TARGET REACHED</b>\nالربح اليومي: ${(gainPct*100).toFixed(2)}%\nيتم إيقاف التداول حتى الغد للحفاظ على الأرباح.`
        ).catch(() => {});
      }
    }
    return hit;
  }
}
