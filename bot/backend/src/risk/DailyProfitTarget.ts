import { DatabaseManager } from '../database/DatabaseManager';
import { SystemConfig } from '../types/trading.types';
import { TelegramBot } from '../notifications/TelegramBot';

export class DailyProfitTarget {
  private notified = '';
  constructor(private config: SystemConfig, private db: DatabaseManager, private telegram: TelegramBot) {}

  reached(_currentEquity?: number): boolean {
    const stats = this.db.getTodayStats();
    const today = new Date().toISOString().slice(0, 10);
    const since = Date.parse(`${today}T00:00:00.000Z`);
    const partial = this.db.getOpenPartialRealizedPnlSince(since);
    const realized = Number(stats?.pnl ?? 0) + partial;
    if (!(this.config.accountBalance > 0) || !Number.isFinite(realized)) return false;
    const gainPct = realized / this.config.accountBalance;
    const hit = gainPct >= this.config.dailyProfitTarget;
    if (hit) {
      if (this.notified !== today) {
        this.notified = today;
        this.telegram.sendMessage(
          `🎯 <b>DAILY TARGET REACHED</b>\nالربح اليومي: ${(gainPct*100).toFixed(2)}%\nيتم إيقاف التداول حتى الغد للحفاظ على الأرباح.`
        ).catch(() => {});
      }
    }
    return hit;
  }}
