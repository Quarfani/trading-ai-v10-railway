import { DatabaseManager } from '../database/DatabaseManager';
import { SystemConfig } from '../types/trading.types';
import { TelegramBot } from '../notifications/TelegramBot';

export class DailyProfitTarget {
  private notified = '';
  constructor(private config: SystemConfig, private db: DatabaseManager, private telegram: TelegramBot) {}

  reached(currentEquity?: number): boolean {,    const today = new Date().toISOString().slice(0, 10);,    let gainPct = 0;,,    if (this.config.mode !== 'paper' &&,        Number.isFinite(Number(currentEquity)) && Number(currentEquity) > 0) {,      const account = String(this.config.accountName ?? 'default').replace(/[^a-zA-Z0-9._-]/g, '_');,      const key = `daily_start_equity:${account}:${today}`;,      let anchor = Number(this.db.getSetting(key));,      if (!(anchor > 0) || !Number.isFinite(anchor)) {,        anchor = Number(currentEquity);,        this.db.setSetting(key, anchor.toFixed(8));,      },      gainPct = (Number(currentEquity) - anchor) / anchor;,    } else {,      const stats = this.db.getTodayStats();,      const since = Date.parse(`${today}T00:00:00.000Z`);,      const partial = this.db.getOpenPartialRealizedPnlSince(since);,      const realized = Number(stats?.pnl ?? 0) + partial;,      if (!(this.config.accountBalance > 0) || !Number.isFinite(realized)) return false;,      gainPct = realized / this.config.accountBalance;,    },,    const hit = gainPct >= this.config.dailyProfitTarget;
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
