/**
 * DRAWDOWN POSITION SCALER
 * ══════════════════════════════════════════════════════════════════════════
 * يقلّص حجم الصفقات تلقائياً عند الاقتراب من حدود الـ Drawdown:
 *
 *   0–3%  Drawdown → 100% (حجم طبيعي)
 *   3–5%  Drawdown →  70% (تحذير)
 *   5–8%  Drawdown →  40% (خطر)
 *   8–10% Drawdown →  20% (حرج)
 *   >10%  Drawdown →   0% (إيقاف تام)
 *
 * مختلف عن DailyLossGuard لأنه:
 *   - يعمل على المدى البعيد (Peak-to-Trough عبر أسابيع)
 *   - لا يوقف التداول بشكل مطلق بل يقلص تدريجياً
 *   - يسمح بالتعافي بعد ارتفاع الـ Equity
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger }          from '../utils/Logger';

export interface DrawdownStatus {
  peakEquity:     number;
  currentEquity:  number;
  drawdownPct:    number;   // 0–1
  volumeScale:    number;   // 0–1 multiplier for position sizing
  level:          'NORMAL' | 'WARNING' | 'DANGER' | 'CRITICAL' | 'STOP';
  message:        string;
}

export class DrawdownScaler {
  private logger      = new Logger('DrawdownScaler');
  private peakEquity  = 0;
  private lastUpdated = 0;
  private readonly peakKey: string;

  constructor(
    private db: DatabaseManager,
    initialBalance: number,
    private failClosed = false,
    accountKey = 'default',
  ) {
    this.peakEquity = initialBalance;
    this.peakKey = `peak_equity:${accountKey.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    this.loadPeak();
  }

  /**
   * Get current drawdown status and volume scaling factor.
   * @param currentEquity  Live account equity
   */
  getStatus(currentEquity: number): DrawdownStatus {
    // Update peak if equity is at a new high
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
      this.savePeak();
      this.logger.info(`New equity peak: $${currentEquity.toFixed(2)}`);
    }

    const drawdownPct = this.peakEquity > 0
      ? (this.peakEquity - currentEquity) / this.peakEquity
      : 0;

    const { scale, level } = this.computeScale(drawdownPct);

    const message = level === 'NORMAL'
      ? `✓ Drawdown: ${pct(drawdownPct)} (normal)`
      : level === 'WARNING'
      ? `⚠ Drawdown: ${pct(drawdownPct)} — reducing size to ${pct(scale)}`
      : level === 'DANGER'
      ? `🔶 Drawdown: ${pct(drawdownPct)} — critical reduction to ${pct(scale)}`
      : level === 'CRITICAL'
      ? `🔴 Drawdown: ${pct(drawdownPct)} — minimal trading (${pct(scale)})`
      : `🛑 Drawdown: ${pct(drawdownPct)} — TRADING STOPPED`;

    if (level !== 'NORMAL') {
      this.logger.warn(message);
    }

    return {
      peakEquity:    this.peakEquity,
      currentEquity,
      drawdownPct,
      volumeScale:   scale,
      level,
      message,
    };
  }

  /**
   * Check if trading should be stopped entirely due to drawdown.
   */
  shouldStop(currentEquity: number): boolean {
    return this.getStatus(currentEquity).level === 'STOP';
  }

  /**
   * Get volume multiplier for position sizing.
   * Returns 0 if trading should stop.
   */
  volumeMultiplier(currentEquity: number): number {
    return this.getStatus(currentEquity).volumeScale;
  }

  /** Manually reset peak (e.g. after manual deposit) */
  resetPeak(newPeak: number) {
    this.peakEquity = newPeak;
    this.savePeak();
    this.logger.info(`Peak manually reset to $${newPeak.toFixed(2)}`);
  }

  // ─── Scale computation ────────────────────────────────────────────────────

  private computeScale(dd: number): { scale: number; level: DrawdownStatus['level'] } {
    if (dd >= 0.10)       return { scale: 0.00, level: 'STOP' };
    if (dd >= 0.08)       return { scale: 0.20, level: 'CRITICAL' };
    if (dd >= 0.05)       return { scale: 0.40, level: 'DANGER' };
    if (dd >= 0.03)       return { scale: 0.70, level: 'WARNING' };
    return { scale: 1.00, level: 'NORMAL' };
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private savePeak() {
    try {
      this.db.setSetting(this.peakKey, String(this.peakEquity));
      this.lastUpdated = Date.now();
    } catch (e) {
      if (this.failClosed) throw new Error(`Equity peak persistence failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private loadPeak() {
    try {
      const saved = this.db.getSetting(this.peakKey);
      if (saved) {
        this.peakEquity = Math.max(this.peakEquity, Number(saved));
        this.logger.info(`Loaded equity peak: $${this.peakEquity.toFixed(2)}`);
      }
    } catch (e) {
      if (this.failClosed) throw new Error(`Equity peak load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
