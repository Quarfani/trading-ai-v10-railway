/**
 * TIME-BASED WIN RATE FILTER — v9.0
 * ══════════════════════════════════════════════════════════════════════════
 * يحلل نتائج الصفقات التاريخية لتحديد أي ساعات/أيام تحقق أعلى ربح.
 *
 * المخرجات:
 *   - hourlyWinRate[0..23]: معدل الفوز لكل ساعة UTC
 *   - dailyWinRate[0..6]:   معدل الفوز لكل يوم (0=الأحد, 6=السبت)
 *   - bestHours:            أفضل 8 ساعات للتداول
 *   - worstHours:           أسوأ 4 ساعات (يُوصى بتجنبها)
 *
 * الاستخدام في RiskManager:
 *   إذا الساعة الحالية في worstHours → تقليل حجم الصفقة 50%
 *   إذا في bestHours → إبقاء الحجم كاملاً أو +10%
 *
 * يتحدث تلقائياً كل 24 ساعة من DB.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger }          from '../utils/Logger';

export interface TimeHeatmap {
  hourlyWinRate: number[];    // index 0–23
  dailyWinRate:  number[];    // index 0–6
  hourlyTrades:  number[];    // trade count per hour
  bestHours:     number[];    // top performing hours (UTC)
  worstHours:    number[];    // bottom performing hours
  bestDays:      number[];    // best days of week
  updatedAt:     number;
}

export interface TimeScore {
  multiplier:  number;   // volume multiplier (0.5–1.15)
  reason:      string;
  hourWR:      number;
  dayWR:       number;
}

export class TimeBasedWinRateFilter {
  private logger   = new Logger('TimeFilter');
  private heatmap: TimeHeatmap | null = null;
  private lastLoad = 0;

  constructor(private db: DatabaseManager) {}

  /** Get volume multiplier for current time */
  getMultiplier(tsMs = Date.now()): TimeScore {
    this.maybeRefresh();

    if (!this.heatmap) {
      return { multiplier: 1.0, reason: 'No heatmap data yet', hourWR: 0.5, dayWR: 0.5 };
    }

    const hour = new Date(tsMs).getUTCHours();
    const day  = new Date(tsMs).getUTCDay();

    const hourWR = this.heatmap.hourlyWinRate[hour] ?? 0.5;
    const dayWR  = this.heatmap.dailyWinRate[day]   ?? 0.5;
    const trades = this.heatmap.hourlyTrades[hour]  ?? 0;

    // Not enough data for this hour → neutral
    if (trades < 10) {
      return { multiplier: 1.0, reason: `Insufficient data for hour ${hour}:00`, hourWR, dayWR };
    }

    let mult   = 1.0;
    const parts: string[] = [];

    // Hour-based adjustment
    if (hourWR >= 0.60) {
      mult *= 1.10;
      parts.push(`Best hour ${hour}:00 WR=${(hourWR*100).toFixed(0)}%`);
    } else if (hourWR >= 0.55) {
      mult *= 1.05;
      parts.push(`Good hour ${hour}:00 WR=${(hourWR*100).toFixed(0)}%`);
    } else if (hourWR < 0.42) {
      mult *= 0.50;
      parts.push(`Bad hour ${hour}:00 WR=${(hourWR*100).toFixed(0)}% → half size`);
    } else if (hourWR < 0.48) {
      mult *= 0.75;
      parts.push(`Weak hour ${hour}:00 WR=${(hourWR*100).toFixed(0)}%`);
    }

    // Day-based adjustment
    if (dayWR >= 0.60) {
      mult *= 1.05;
      parts.push(`Best day=${day} WR=${(dayWR*100).toFixed(0)}%`);
    } else if (dayWR < 0.44) {
      mult *= 0.80;
      parts.push(`Bad day=${day} WR=${(dayWR*100).toFixed(0)}%`);
    }

    mult = Math.max(0.30, Math.min(1.20, mult));

    return {
      multiplier: +mult.toFixed(2),
      reason:     parts.join(' | ') || `Neutral hour ${hour}:00`,
      hourWR, dayWR,
    };
  }

  /** Should we block trading at this time? (worst hours, <35% WR with enough data) */
  shouldBlock(tsMs = Date.now()): boolean {
    this.maybeRefresh();
    if (!this.heatmap) return false;

    const hour   = new Date(tsMs).getUTCHours();
    const trades = this.heatmap.hourlyTrades[hour] ?? 0;
    if (trades < 20) return false; // not enough data to block

    const wr = this.heatmap.hourlyWinRate[hour] ?? 0.5;
    return wr < 0.35; // extremely bad hour → block
  }

  /** Get heatmap data for dashboard */
  getHeatmap(): TimeHeatmap | null {
    this.maybeRefresh();
    return this.heatmap;
  }

  private maybeRefresh(): void {
    if (!this.heatmap || Date.now() - this.lastLoad > 24 * 3_600_000) {
      this.load();
    }
  }

  private load(): void {
    try {
      const cutoff = Date.now() - 90 * 24 * 3_600_000; // last 90 days

      const rows = this.db.raw().prepare(`
        SELECT
          CAST(strftime('%H', datetime(openedAt/1000, 'unixepoch')) AS INTEGER) AS hour,
          CAST(strftime('%w', datetime(openedAt/1000, 'unixepoch')) AS INTEGER) AS dow,
          profit
        FROM trades
        WHERE status='closed' AND openedAt > ? AND profit IS NOT NULL
      `).all(cutoff) as Array<{ hour: number; dow: number; profit: number }>;

      if (rows.length < 30) {
        this.logger.debug(`TimeFilter: only ${rows.length} closed trades — not enough for heatmap`);
        return;
      }

      // Build hourly stats
      const hourlyWR:     number[] = new Array(24).fill(0.5);
      const hourlyTrades: number[] = new Array(24).fill(0);
      const hourWins:     number[] = new Array(24).fill(0);

      const dailyWR:      number[] = new Array(7).fill(0.5);
      const dailyTrades:  number[] = new Array(7).fill(0);
      const dayWins:      number[] = new Array(7).fill(0);

      for (const r of rows) {
        const h = r.hour;
        const d = r.dow;
        hourlyTrades[h]++;
        if (r.profit > 0) hourWins[h]++;
        dailyTrades[d]++;
        if (r.profit > 0) dayWins[d]++;
      }

      for (let h = 0; h < 24; h++) {
        if (hourlyTrades[h] >= 5)
          hourlyWR[h] = hourWins[h] / hourlyTrades[h];
      }
      for (let d = 0; d < 7; d++) {
        if (dailyTrades[d] >= 5)
          dailyWR[d] = dayWins[d] / dailyTrades[d];
      }

      // Best/worst hours (with enough data)
      const rankedHours = Array.from({ length: 24 }, (_, i) => i)
        .filter(h => hourlyTrades[h] >= 10)
        .sort((a, b) => hourlyWR[b] - hourlyWR[a]);

      const bestHours  = rankedHours.slice(0, 8);
      const worstHours = rankedHours.slice(-4);
      const bestDays   = Array.from({ length: 7 }, (_, i) => i)
        .filter(d => dailyTrades[d] >= 5)
        .sort((a, b) => dailyWR[b] - dailyWR[a])
        .slice(0, 3);

      this.heatmap = {
        hourlyWinRate: hourlyWR, hourlyTrades,
        dailyWinRate:  dailyWR,
        bestHours, worstHours, bestDays,
        updatedAt: Date.now(),
      };

      this.lastLoad = Date.now();

      this.logger.info(
        `TimeFilter heatmap loaded: ${rows.length} trades | ` +
        `Best hours: ${bestHours.slice(0,3).map(h => `${h}:00`).join(', ')} | ` +
        `Worst: ${worstHours.map(h => `${h}:00`).join(', ')}`
      );

      // Persist to DB for dashboard
      this.db.setSetting('time_heatmap', JSON.stringify(this.heatmap));

    } catch (e: any) {
      this.logger.warn(`TimeFilter load failed: ${e.message}`);
    }
  }
}
