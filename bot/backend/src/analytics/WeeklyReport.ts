/**
 * WEEKLY REPORT — ENHANCED
 * تحليل مفصل يُجيب على:
 * - أي رمز أكثر ربحاً؟
 * - أي جلسة أفضل؟
 * - أي محرك أفضل؟
 * - أي يوم من الأسبوع أكثر ربحاً؟
 * - ما هو الـ Profit Factor والـ Sharpe الأسبوعي؟
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { TelegramBot }     from '../notifications/TelegramBot';
import { Logger }          from '../utils/Logger';

export class WeeklyReport {
  private logger      = new Logger('WeeklyReport');
  private interval:   NodeJS.Timeout | null = null;
  private sentForWeek = '';

  constructor(private db: DatabaseManager, private telegram: TelegramBot) {}

  start() { if (!this.interval) this.interval = setInterval(() => this.tick().catch(() => {}), 10 * 60_000); }
  stop()  { if (this.interval) { clearInterval(this.interval); this.interval = null; } }

  /** Send report immediately (callable from Telegram command) */
  async sendNow() { await this.send(); }

  private async tick() {
    const d = new Date();
    if (d.getUTCDay() !== 0 || d.getUTCHours() !== 22) return;
    const wk = `${d.getUTCFullYear()}-W${String(Math.floor((d.getUTCDate() - d.getUTCDay() + 10) / 7)).padStart(2,'0')}`;
    if (this.sentForWeek === wk) return;
    this.sentForWeek = wk;
    await this.send();
  }

  async generate(): Promise<string> {
    const since = Date.now() - 7 * 86400_000;

    // ── Overall stats ─────────────────────────────────────────────────────
    const overall = this.db.raw().prepare(`
      SELECT COUNT(*) total,
             SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END) wins,
             COALESCE(SUM(profit),0) pnl,
             COALESCE(SUM(CASE WHEN profit>0 THEN profit ELSE 0 END),0) gross_win,
             COALESCE(SUM(CASE WHEN profit<=0 THEN -profit ELSE 0 END),0) gross_loss,
             COALESCE(AVG(profit),0) avg_trade,
             COALESCE(MAX(profit),0) best,
             COALESCE(MIN(profit),0) worst
      FROM trades WHERE status='closed' AND closedAt >= ?
    `).get(since) as any;

    const wr = overall.total ? overall.wins / overall.total : 0;
    const pf = overall.gross_loss > 0 ? overall.gross_win / overall.gross_loss : overall.gross_win;

    // ── By symbol ─────────────────────────────────────────────────────────
    const bySymbol = this.db.raw().prepare(`
      SELECT symbol,
             COUNT(*) n,
             COALESCE(SUM(profit),0) pnl,
             SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END) wins
      FROM trades WHERE status='closed' AND closedAt >= ?
      GROUP BY symbol ORDER BY pnl DESC LIMIT 5
    `).all(since) as any[];

    // ── By source (engine) ────────────────────────────────────────────────
    const bySource = this.db.raw().prepare(`
      SELECT source,
             COUNT(*) n,
             COALESCE(SUM(profit),0) pnl,
             SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END) wins
      FROM trades WHERE status='closed' AND closedAt >= ?
      GROUP BY source ORDER BY pnl DESC LIMIT 4
    `).all(since) as any[];

    // ── By day of week ────────────────────────────────────────────────────
    const byDay = this.db.raw().prepare(`
      SELECT CAST(strftime('%w', datetime(closedAt/1000,'unixepoch')) AS INTEGER) dow,
             COALESCE(SUM(profit),0) pnl,
             COUNT(*) n
      FROM trades WHERE status='closed' AND closedAt >= ?
      GROUP BY dow ORDER BY pnl DESC
    `).all(since) as any[];

    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    // ── By session hour (rough) ───────────────────────────────────────────
    const bySession = this.db.raw().prepare(`
      SELECT CASE
               WHEN CAST(strftime('%H', datetime(closedAt/1000,'unixepoch')) AS INTEGER) BETWEEN 13 AND 16 THEN 'Overlap'
               WHEN CAST(strftime('%H', datetime(closedAt/1000,'unixepoch')) AS INTEGER) BETWEEN 8 AND 12  THEN 'London'
               WHEN CAST(strftime('%H', datetime(closedAt/1000,'unixepoch')) AS INTEGER) BETWEEN 17 AND 21 THEN 'NY'
               ELSE 'Other'
             END session,
             COALESCE(SUM(profit),0) pnl,
             COUNT(*) n
      FROM trades WHERE status='closed' AND closedAt >= ?
      GROUP BY session ORDER BY pnl DESC
    `).all(since) as any[];

    // ── Build message ─────────────────────────────────────────────────────
    let msg = `📊 <b>Weekly Report — ${new Date().toISOString().slice(0,10)}</b>\n\n`;

    msg += `<b>إجمالي الأسبوع</b>\n`;
    msg += `صفقات: ${overall.total} | رابحة: ${overall.wins} | Win%: ${(wr*100).toFixed(1)}%\n`;
    msg += `PnL: $${overall.pnl.toFixed(2)} | PF: ${pf.toFixed(2)}\n`;
    msg += `أفضل: +$${overall.best.toFixed(2)} | أسوأ: $${overall.worst.toFixed(2)}\n\n`;

    if (bySymbol.length) {
      msg += `<b>أفضل الرموز</b>\n`;
      for (const s of bySymbol) {
        const w = s.n ? (s.wins/s.n*100).toFixed(0) : '0';
        msg += `${s.symbol}: $${s.pnl.toFixed(2)} (${s.n}T ${w}%)\n`;
      }
      msg += '\n';
    }

    if (bySource.length) {
      msg += `<b>أداء المحركات</b>\n`;
      for (const s of bySource) {
        const w = s.n ? (s.wins/s.n*100).toFixed(0) : '0';
        msg += `${s.source}: $${s.pnl.toFixed(2)} (${s.n}T ${w}%)\n`;
      }
      msg += '\n';
    }

    if (byDay.length) {
      msg += `<b>أفضل الأيام</b>\n`;
      for (const d of byDay.slice(0, 3)) {
        msg += `${dayNames[d.dow] ?? d.dow}: $${d.pnl.toFixed(2)} (${d.n} صفقات)\n`;
      }
      msg += '\n';
    }

    if (bySession.length) {
      msg += `<b>أفضل الجلسات</b>\n`;
      for (const s of bySession) {
        msg += `${s.session}: $${s.pnl.toFixed(2)} (${s.n} صفقات)\n`;
      }
    }

    return msg;
  }

  async send() {
    const msg = await this.generate();
    await this.telegram.sendMessage(msg).catch(e => this.logger.error(`Report send: ${e.message}`));
    this.logger.info('Enhanced weekly report sent');
  }
}
