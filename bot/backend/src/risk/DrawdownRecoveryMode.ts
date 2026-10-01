/**
 * DRAWDOWN RECOVERY MODE — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُطبّق قواعد حماية صارمة خلال فترات الخسائر المتراكمة.
 *
 * المستويات:
 *   GREEN  (DD < 3%)  : تداول عادي
 *   YELLOW (DD 3–5%)  : تقليل الحجم إلى 70% + رفع minConfidence
 *   ORANGE (DD 5–8%)  : تقليل الحجم إلى 40% + استراتيجيات حذرة فقط
 *   RED    (DD 8–10%) : تقليل الحجم إلى 20% + ICHIMOKU+RSI فقط
 *   STOP   (DD > 10%) : إيقاف كامل حتى مراجعة يدوية
 *
 * Recovery:
 *   يعود للمستوى الأعلى عند استعادة 50% من الخسارة
 * ══════════════════════════════════════════════════════════════════════════
 */
import { DatabaseManager } from '../database/DatabaseManager';
import { TelegramBot }     from '../notifications/TelegramBot';
import { Logger }          from '../utils/Logger';

export type RecoveryLevel = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'STOP';

export interface RecoveryState {
  level:              RecoveryLevel;
  drawdownPct:        number;
  peakEquity:         number;
  currentEquity:      number;
  volumeMultiplier:   number;
  minConfidenceBoost: number;   // add to base minConfidence
  allowedStrategies:  string[] | null; // null = all allowed
  maxOpenTrades:      number;
  message:            string;
}

const LEVEL_CONFIG: Record<RecoveryLevel, Omit<RecoveryState, 'level' | 'drawdownPct' | 'peakEquity' | 'currentEquity' | 'message'>> = {
  GREEN:  { volumeMultiplier: 1.0, minConfidenceBoost: 0,    allowedStrategies: null,                                              maxOpenTrades: 99 },
  YELLOW: { volumeMultiplier: 0.7, minConfidenceBoost: 0.05, allowedStrategies: null,                                              maxOpenTrades: 4  },
  ORANGE: { volumeMultiplier: 0.4, minConfidenceBoost: 0.08, allowedStrategies: ['TREND','ICHIMOKU','RSI','STRUCTURE'],             maxOpenTrades: 3  },
  RED:    { volumeMultiplier: 0.2, minConfidenceBoost: 0.12, allowedStrategies: ['ICHIMOKU','RSI'],                                 maxOpenTrades: 2  },
  STOP:   { volumeMultiplier: 0.0, minConfidenceBoost: 0.20, allowedStrategies: [],                                                 maxOpenTrades: 0  },
};

export class DrawdownRecoveryMode {
  private logger     = new Logger('RecoveryMode');
  private peakEquity = 0;
  private lastLevel: RecoveryLevel = 'GREEN';
  private notifiedLevel: RecoveryLevel | null = null;
  private peakKey = 'peak_equity:default';

  constructor(
    private db:       DatabaseManager,
    private telegram: TelegramBot,
    startEquity:      number,
    accountKey = 'default',
  ) {
    this.peakKey = `peak_equity:${accountKey.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    this.peakEquity = this.loadPeak() || startEquity;
  }

  evaluate(currentEquity: number): RecoveryState {
    // Update peak
    if (currentEquity > this.peakEquity) {
      this.peakEquity = currentEquity;
      this.savePeak(currentEquity);
    }

    const drawdownPct = this.peakEquity > 0
      ? (this.peakEquity - currentEquity) / this.peakEquity
      : 0;

    const level = this.calcLevel(drawdownPct);
    const cfg   = LEVEL_CONFIG[level];

    // Notify on level change
    if (level !== this.lastLevel) {
      this.onLevelChange(this.lastLevel, level, drawdownPct, currentEquity);
      this.lastLevel = level;
    }

    const messages: Record<RecoveryLevel, string> = {
      GREEN:  `✅ Normal trading (DD ${(drawdownPct*100).toFixed(1)}%)`,
      YELLOW: `⚠️ Recovery YELLOW: vol×0.7, conf+5% (DD ${(drawdownPct*100).toFixed(1)}%)`,
      ORANGE: `🟠 Recovery ORANGE: vol×0.4, limited strategies (DD ${(drawdownPct*100).toFixed(1)}%)`,
      RED:    `🔴 Recovery RED: vol×0.2, ICHIMOKU+RSI only (DD ${(drawdownPct*100).toFixed(1)}%)`,
      STOP:   `🛑 Recovery STOP: trading halted at ${(drawdownPct*100).toFixed(1)}% DD — manual review required`,
    };

    return {
      level, drawdownPct,
      peakEquity:   this.peakEquity,
      currentEquity,
      message:      messages[level],
      ...cfg,
    };
  }

  /** Check if a strategy is allowed in current recovery level */
  isStrategyAllowed(strategyName: string, state: RecoveryState): boolean {
    if (!state.allowedStrategies) return true;
    return state.allowedStrategies.some(s => strategyName.toUpperCase().includes(s));
  }

  /** Calculate recovery progress (0 = just started, 1 = fully recovered) */
  recoveryProgress(currentEquity: number): number {
    const loss = this.peakEquity - currentEquity;
    if (loss <= 0) return 1;
    const initialLoss = this.peakEquity * 0.05; // assume entry at 5% DD
    return Math.max(0, Math.min(1, 1 - loss / Math.max(initialLoss, loss)));
  }

  private calcLevel(dd: number): RecoveryLevel {
    if (dd >= 0.10) return 'STOP';
    if (dd >= 0.08) return 'RED';
    if (dd >= 0.05) return 'ORANGE';
    if (dd >= 0.03) return 'YELLOW';
    return 'GREEN';
  }

  private onLevelChange(from: RecoveryLevel, to: RecoveryLevel, dd: number, equity: number) {
    const emoji = { GREEN: '✅', YELLOW: '⚠️', ORANGE: '🟠', RED: '🔴', STOP: '🛑' };
    const msg   =
      `${emoji[to]} <b>Recovery Level: ${from} → ${to}</b>\n` +
      `DD: ${(dd * 100).toFixed(2)}% | Equity: $${equity.toFixed(2)}\n` +
      `Vol: ×${LEVEL_CONFIG[to].volumeMultiplier} | ` +
      `MaxTrades: ${LEVEL_CONFIG[to].maxOpenTrades}`;

    this.telegram.sendMessage(msg).catch(() => {});
    this.logger.warn(`Recovery level: ${from} → ${to} | DD=${(dd*100).toFixed(2)}%`);
  }

  private loadPeak(): number {
    try {
      const v = this.db.getSetting(this.peakKey);
      return v ? Number(v) : 0;
    } catch { return 0; }
  }

  private savePeak(equity: number): void {
    try { this.db.setSetting(this.peakKey, String(equity)); } catch { /* pass */ }
  }
}
