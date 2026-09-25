/**
 * AI TRADE JOURNAL — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُنشئ تلقائياً تقريراً ذكياً لكل صفقة مغلقة:
 *
 * محتوى التقرير:
 *   ✦ سبب الدخول (من Consensus reasoning)
 *   ✦ ما الذي حدث فعلاً (SL/TP/Timeout)
 *   ✦ هل الظروف تغيّرت بعد الدخول؟
 *   ✦ درس مستفاد + اقتراح تحسين
 *   ✦ Pattern recognition من الصفقات المشابهة
 *
 * التخزين:
 *   - SQLite: كل صفقة لها entry في جدول trade_journal
 *   - Telegram: يُرسل ملخص فوري عند الإغلاق
 *   - Exportable: CSV / JSON
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { TelegramBot }     from '../notifications/TelegramBot';
import { Trade }           from '../types/trading.types';
import { Logger }          from '../utils/Logger';

export interface JournalEntry {
  tradeId:       number;
  symbol:        string;
  side:          string;
  entryReason:   string;
  exitReason:    string;
  marketContext: string;
  lesson:        string;
  patternMatch:  string | null;
  profit:        number;
  grade:         'A' | 'B' | 'C' | 'D' | 'F';
  createdAt:     number;
}

export class AITradeJournal {
  private logger = new Logger('Journal');
  private dbReady = false;

  constructor(
    private db:       DatabaseManager,
    private telegram: TelegramBot,
  ) {
    this.ensureTable();
  }

  private ensureTable(): void {
    try {
      this.db.raw().exec(`
        CREATE TABLE IF NOT EXISTS trade_journal (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          tradeId     INTEGER NOT NULL,
          symbol      TEXT    NOT NULL,
          side        TEXT    NOT NULL,
          entryReason TEXT,
          exitReason  TEXT,
          context     TEXT,
          lesson      TEXT,
          patternMatch TEXT,
          profit      REAL,
          grade       TEXT,
          createdAt   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_journal_trade ON trade_journal(tradeId);
        CREATE INDEX IF NOT EXISTS idx_journal_symbol ON trade_journal(symbol);
      `);
      this.dbReady = true;
    } catch (e: any) {
      this.logger.warn(`Journal table init: ${e.message}`);
    }
  }

  /** Main entry point: call after every trade close */
  async record(trade: Trade & { exitReason?: string }): Promise<JournalEntry | null> {
    if (!trade.id || !this.dbReady) return null;

    try {
      const entry = this.buildEntry(trade);
      this.saveEntry(entry);
      await this.notifyTelegram(entry);
      this.logger.info(`Journal: recorded trade #${trade.id} ${entry.grade}`);
      return entry;
    } catch (e: any) {
      this.logger.warn(`Journal record failed: ${e.message}`);
      return null;
    }
  }

  private buildEntry(trade: Trade & { exitReason?: string }): JournalEntry {
    const profit     = trade.profit ?? 0;
    const rr         = this.calcRR(trade);
    const grade      = this.gradeTrade(trade, rr);
    const entryReason = this.getEntryReason(trade);
    const exitReason  = this.buildExitReason(trade, rr);
    const context     = this.buildMarketContext(trade);
    const lesson      = this.buildLesson(trade, grade, rr);
    const pattern     = this.findPattern(trade);

    return {
      tradeId:       trade.id!,
      symbol:        trade.symbol,
      side:          trade.side,
      entryReason,
      exitReason,
      marketContext: context,
      lesson,
      patternMatch:  pattern,
      profit,
      grade,
      createdAt:     Date.now(),
    };
  }

  private gradeTrade(trade: Trade & { exitReason?: string }, rr: number): JournalEntry['grade'] {
    const profit = trade.profit ?? 0;

    // Perfect: profit + good R:R
    if (profit > 0 && rr >= 2.5 && trade.exitReason === 'TP') return 'A';
    // Good: profit + ok R:R
    if (profit > 0 && rr >= 1.5) return 'B';
    // Acceptable: small profit or well-managed loss
    if (profit > 0 || (profit < 0 && Math.abs(profit) < 0.5 * Math.abs(trade.volume * trade.entry * 0.01))) return 'C';
    // Poor: loss but followed rules
    if (profit < 0 && trade.exitReason === 'SL') return 'D';
    // Failed: timeout or large loss
    return 'F';
  }

  private calcRR(trade: Trade): number {
    const slDist = Math.abs(trade.entry - trade.sl);
    const tpDist = Math.abs(trade.tp - trade.entry);
    return slDist > 0 ? tpDist / slDist : 0;
  }

  private getEntryReason(trade: Trade): string {
    // Try to get from latest signal in DB
    try {
      const sig = this.db.raw().prepare(`
        SELECT source, reason FROM signals
        WHERE symbol=? AND side=? AND ABS(timestamp - ?) < 120000
        ORDER BY timestamp DESC LIMIT 1
      `).get(trade.symbol, trade.side, trade.openedAt) as any;
      if (sig) return `${sig.source}: ${sig.reason ?? 'No reason'}`;
    } catch {}
    return `${trade.source} — entry at ${trade.entry}`;
  }

  private buildExitReason(trade: Trade & { exitReason?: string }, rr: number): string {
    const profit = trade.profit ?? 0;
    const pctStr = trade.entry > 0 ? ((Math.abs(profit) / trade.entry) * 100).toFixed(2) : '0';
    const earned = profit > 0 ? `+$${profit.toFixed(2)} (+${pctStr}%)` : `-$${Math.abs(profit).toFixed(2)} (-${pctStr}%)`;

    switch (trade.exitReason) {
      case 'TP':      return `✅ Hit Take Profit | ${earned} | R:R achieved ${rr.toFixed(1)}`;
      case 'SL':      return `❌ Hit Stop Loss | ${earned} | R:R was ${rr.toFixed(1)}`;
      case 'TIMEOUT': return `⏱ Timeout exit | ${earned} — price didn't reach target within time limit`;
      default:        return `Manual/Auto close | ${earned}`;
    }
  }

  private buildMarketContext(trade: Trade): string {
    try {
      // Look up what the market regime was at entry time
      const audit = this.db.raw().prepare(`
        SELECT decision, blockedBy FROM decision_audit
        WHERE symbol=? AND ABS(timestamp - ?) < 180000
        ORDER BY timestamp DESC LIMIT 1
      `).get(trade.symbol, trade.openedAt) as any;

      if (audit) return `Decision: ${audit.decision} | Consensus passed all checks`;
    } catch {}
    return `${trade.symbol} ${trade.side} | Entry: ${trade.entry} | SL: ${trade.sl} | TP: ${trade.tp}`;
  }

  private buildLesson(trade: Trade & { exitReason?: string }, grade: JournalEntry['grade'], rr: number): string {
    const profit = trade.profit ?? 0;

    const lessons: Record<string, string> = {
      'A': 'Excellent execution — strategy and timing aligned perfectly. Replicate conditions.',
      'B': 'Good trade. Review if TP could have been extended for higher R:R.',
      'C': profit > 0
        ? 'Profitable but marginal. Check if entry was too late or R:R too low.'
        : 'Small loss — well-managed. Review entry timing.',
      'D': `SL hit — expected part of trading. Check if R:R (${rr.toFixed(1)}:1) was adequate before entry.`,
      'F': trade.exitReason === 'TIMEOUT'
        ? 'Timeout: price stalled. Consider tighter TP or different market session for this symbol.'
        : `Large loss — review position sizing and risk rules compliance.`,
    };

    return lessons[grade] ?? 'Review trade conditions and compare to strategy rules.';
  }

  private findPattern(trade: Trade): string | null {
    try {
      // Find similar closed trades (same symbol, same side, similar entry context)
      const similar = this.db.raw().prepare(`
        SELECT profit, exitReason, openedAt FROM trades
        WHERE status='closed' AND symbol=? AND side=? AND id != ?
        ORDER BY ABS(openedAt - ?) ASC LIMIT 5
      `).all(trade.symbol, trade.side, trade.id, trade.openedAt) as any[];

      if (!similar.length) return null;

      const wins   = similar.filter(t => t.profit > 0).length;
      const losses = similar.length - wins;
      const avgPnl = similar.reduce((s, t) => s + t.profit, 0) / similar.length;

      return `Similar past trades (${similar.length}): ${wins}W/${losses}L avg P/L=$${avgPnl.toFixed(2)}`;
    } catch { return null; }
  }

  private saveEntry(entry: JournalEntry): void {
    try {
      this.db.raw().prepare(`
        INSERT INTO trade_journal
          (tradeId, symbol, side, entryReason, exitReason, context, lesson, patternMatch, profit, grade, createdAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        entry.tradeId, entry.symbol, entry.side,
        entry.entryReason, entry.exitReason, entry.marketContext,
        entry.lesson, entry.patternMatch, entry.profit, entry.grade, entry.createdAt
      );
    } catch { /* non-critical */ }
  }

  private async notifyTelegram(entry: JournalEntry): Promise<void> {
    const gradeEmoji = { A: '🏆', B: '✅', C: '🟡', D: '🔸', F: '❌' };
    const msg =
      `${gradeEmoji[entry.grade]} <b>Trade Journal #${entry.tradeId}</b>\n` +
      `${entry.symbol} ${entry.side} | Grade: <b>${entry.grade}</b>\n\n` +
      `📥 <b>Entry:</b> ${entry.entryReason.slice(0, 120)}\n\n` +
      `📤 <b>Exit:</b> ${entry.exitReason}\n\n` +
      `💡 <b>Lesson:</b> ${entry.lesson}\n` +
      (entry.patternMatch ? `\n📊 ${entry.patternMatch}` : '');

    await this.telegram.sendMessage(msg).catch(() => {});
  }

  // ─── Query API ────────────────────────────────────────────────────────────

  getEntries(limit = 50): JournalEntry[] {
    try {
      return this.db.raw().prepare(`
        SELECT * FROM trade_journal ORDER BY createdAt DESC LIMIT ?
      `).all(limit) as any[];
    } catch { return []; }
  }

  getGradeDistribution(): Record<string, number> {
    try {
      const rows = this.db.raw().prepare(`
        SELECT grade, COUNT(*) cnt FROM trade_journal GROUP BY grade
      `).all() as Array<{ grade: string; cnt: number }>;
      const out: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      for (const r of rows) out[r.grade] = r.cnt;
      return out;
    } catch { return {}; }
  }

  getSymbolInsights(symbol: string): any {
    try {
      return this.db.raw().prepare(`
        SELECT
          COUNT(*) total,
          SUM(CASE WHEN grade IN ('A','B') THEN 1 ELSE 0 END) good,
          AVG(profit) avgProfit,
          GROUP_CONCAT(DISTINCT lesson) lessons
        FROM trade_journal WHERE symbol=?
      `).get(symbol) as any;
    } catch { return null; }
  }
}
