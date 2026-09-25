/**
 * POSITION TRACKER
 * ══════════════════════════════════════════════════════════════════════════
 * يتتبع الصفقات المفتوحة ويمنع تكرار الدخول على نفس الرمز.
 *
 * المشكلة التي يحلها:
 *   إذا انتهى دورة المحرك قبل تسجيل الصفقة في DB، قد يُدخل نفس الرمز مرتين
 *   في نفس الاتجاه عبر timeframes مختلفة.
 *
 * الحل:
 *   - يحتفظ بـ in-memory map للصفقات النشطة (symbol → side)
 *   - يتزامن مع DB عند بدء التشغيل وعند كل إغلاق صفقة
 *   - يوفر lock خفيف لمنع race conditions خلال التنفيذ
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger }          from '../utils/Logger';

interface PositionEntry {
  symbol:    string;
  side:      'BUY' | 'SELL';
  openedAt:  number;
  timeframe: string;
  source:    string;
}

export class PositionTracker {
  private readonly logger    = new Logger('PositionTracker');
  private readonly positions = new Map<string, PositionEntry>();
  private readonly locks     = new Set<string>(); // symbol-level execution locks

  constructor(private readonly db: DatabaseManager) {
    this.syncFromDB();
  }

  // ─── DB Sync ──────────────────────────────────────────────────────────────

  syncFromDB(): void {
    try {
      const rows = this.db.getOpenTrades();
      this.positions.clear();
      for (const t of rows) {
        const key = t.symbol.toUpperCase();
        // If multiple open trades on same symbol, keep the latest
        const existing = this.positions.get(key);
        if (!existing || t.openedAt > existing.openedAt) {
          this.positions.set(key, {
            symbol:    t.symbol,
            side:      t.side,
            openedAt:  t.openedAt,
            timeframe: (t as any).timeframe ?? 'UNKNOWN',
            source:    t.source,
          });
        }
      }
      this.logger.info(`PositionTracker synced: ${this.positions.size} open positions`);
    } catch (e: any) {
      this.logger.error(`syncFromDB failed: ${e.message}`);
    }
  }

  // ─── Position checks ──────────────────────────────────────────────────────

  /**
   * Returns true if the symbol already has an open position in ANY direction.
   * Prevents opening opposite or duplicate positions.
   */
  hasOpenPosition(symbol: string): boolean {
    return this.positions.has(symbol.toUpperCase());
  }

  /**
   * Returns true if the symbol has an open position in the SAME direction.
   */
  hasOpenInDirection(symbol: string, side: 'BUY' | 'SELL'): boolean {
    const pos = this.positions.get(symbol.toUpperCase());
    return pos?.side === side;
  }

  /**
   * Returns true if the symbol has an open position in the OPPOSITE direction.
   * This would be a hedge — blocked by default.
   */
  hasOppositePosition(symbol: string, side: 'BUY' | 'SELL'): boolean {
    const pos = this.positions.get(symbol.toUpperCase());
    if (!pos) return false;
    return pos.side !== side;
  }

  getPosition(symbol: string): PositionEntry | undefined {
    return this.positions.get(symbol.toUpperCase());
  }

  getAll(): PositionEntry[] {
    return Array.from(this.positions.values());
  }

  count(): number {
    return this.positions.size;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  recordOpen(symbol: string, side: 'BUY' | 'SELL', timeframe: string, source: string): void {
    const key = symbol.toUpperCase();
    this.positions.set(key, { symbol, side, openedAt: Date.now(), timeframe, source });
    this.logger.debug(`Recorded open: ${symbol} ${side} [${timeframe}]`);
  }

  recordClose(symbol: string): void {
    const key = symbol.toUpperCase();
    if (this.positions.delete(key)) {
      this.logger.debug(`Recorded close: ${symbol}`);
    }
    // Re-check DB in case of multiple lots
    this.syncFromDB();
  }

  // ─── Execution lock (prevents race on same symbol) ─────────────────────

  /**
   * Attempt to acquire a per-symbol execution lock.
   * Returns false immediately if lock is held (non-blocking).
   */
  tryLock(symbol: string): boolean {
    const key = symbol.toUpperCase();
    if (this.locks.has(key)) return false;
    this.locks.add(key);
    return true;
  }

  unlock(symbol: string): void {
    this.locks.delete(symbol.toUpperCase());
  }

  isLocked(symbol: string): boolean {
    return this.locks.has(symbol.toUpperCase());
  }

  // ─── Summary ──────────────────────────────────────────────────────────────

  summary(): Record<string, { side: string; openedAt: number; source: string }> {
    const out: Record<string, { side: string; openedAt: number; source: string }> = {};
    for (const [k, v] of this.positions) {
      out[k] = { side: v.side, openedAt: v.openedAt, source: v.source };
    }
    return out;
  }
}
