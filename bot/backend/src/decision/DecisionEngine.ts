/**
 * DECISION ENGINE
 * ═══════════════════════════════════════════════════════════════════════════
 * Single authority for BUY / SELL / NO_TRADE decisions.
 *
 * FIX [C1]: Pipeline order corrected — Decision now runs BEFORE Risk.
 *   decide() no longer takes RiskResult as input.
 *   It evaluates signal quality independently and outputs BUY/SELL/NO_TRADE.
 *   Risk Manager runs after, as a hard execution gate (not as decision input).
 *
 * FIX [C7]: Audits now written to dedicated `decision_audits` table,
 *   not the settings key-value store.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { Signal, TradeDecision, DecisionAudit, DecisionType, SystemConfig } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger } from '../utils/Logger';

export class DecisionEngine {
  private logger = new Logger('DecisionEngine');

  // Historical win rates — updated periodically via updateWinRates()
  private winRates: Record<string, number> = {
    TREND:    0.55,
    RSI:      0.52,
    BREAKOUT: 0.48,
  };

  // In-memory ring buffer — last 1 000 decisions
  private audits: DecisionAudit[] = [];
  private readonly MAX_AUDITS = 1000;

  constructor(private config: SystemConfig, private db: DatabaseManager) {}

  // ─── Main entry point ─────────────────────────────────────────────────────

  /**
   * Produce a deterministic BUY / SELL / NO_TRADE decision.
   *
   * Called BEFORE RiskManager. Does NOT receive RiskResult.
   * Risk is a separate gate that runs after this call.
   *
   * @param signal       Merged signal (confidence frozen by SignalAggregator)
   * @param openCount    Current open position count (for concentration scoring)
   * @param mtfConfirmed Whether higher-TF trend agrees with signal direction
   */
  decide(
    signal:       Signal,
    openCount:    number,
    mtfConfirmed: boolean,
  ): TradeDecision {
    const auditId = `dec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const reasons: string[] = [];

    // Score signal quality
    const { score, scoreReasons } = this.scoreSignal(signal, openCount, mtfConfirmed);
    reasons.push(...scoreReasons);

    // Confidence threshold gate
    if (score < this.config.minConfidence) {
      reasons.push(`✗ Confidence ${pct(score)} < threshold ${pct(this.config.minConfidence)}`);
      return this.noTrade(auditId, signal, score, reasons);
    }

    // Approved
    const decision: DecisionType = signal.side;
    reasons.push(`✓ APPROVED ${decision} ${signal.symbol} @ ${signal.price}`);
    reasons.push(`  Confidence: ${pct(score)}`);

    const result: TradeDecision = {
      decision,
      confidence: score,
      volume: 0,   // volume is set by RiskManager after this call
      reasons,
      auditId,
    };

    this.recordAudit({
      auditId, timestamp: Date.now(), symbol: signal.symbol, side: signal.side,
      decision, confidence: score, riskPassed: false, blockedBy: '',
    });

    this.logger.info(`[${auditId}] ${decision} ${signal.symbol} conf=${pct(score)}`);
    return result;
  }

  // ─── Scoring ──────────────────────────────────────────────────────────────

  private scoreSignal(
    signal: Signal, openCount: number, mtfConfirmed: boolean,
  ): { score: number; scoreReasons: string[] } {
    const reasons: string[] = [];
    let score = signal.confidence;

    // Multi-engine agreement bonus
    const sourceCount = signal.source.split('+').length;
    if (sourceCount >= 2) {
      score += 0.08;
      reasons.push(`✓ ${sourceCount} strategies agree (+8%)`);
    } else {
      reasons.push(`⚠ Single strategy signal (${signal.source})`);
    }

    // Historical win-rate adjustment (±10%)
    const primary = signal.source.split('+')[0];
    const winRate = this.winRates[primary] ?? 0.50;
    const wrAdj   = (winRate - 0.50) * 0.2;
    score        += wrAdj;
    if (Math.abs(wrAdj) > 0.001) {
      reasons.push(`${primary} win-rate: ${pct(winRate)} (adj ${wrAdj >= 0 ? '+' : ''}${pct(wrAdj)})`);
    }

    // Multi-timeframe confirmation
    if (mtfConfirmed) {
      score += 0.05;
      reasons.push('✓ MTF confirmed (+5%)');
    } else {
      reasons.push('⚠ MTF not confirmed');
    }

    // Open trade concentration penalty
    if (openCount >= 3) {
      const penalty = Math.min(0.15, (openCount - 2) * 0.05);
      score        -= penalty;
      reasons.push(`⚠ ${openCount} open trades (−${pct(penalty)})`);
    }

    // Illiquid hours (21:00–05:00 UTC)
    const hour = new Date(signal.timestamp).getUTCHours();
    if (hour >= 21 || hour <= 5) {
      score -= 0.10;
      reasons.push(`⚠ Illiquid hours ${hour}:00 UTC (−10%)`);
    }

    return { score: Math.min(0.99, Math.max(0.10, score)), scoreReasons: reasons };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private noTrade(
    auditId: string, signal: Signal, score: number, reasons: string[],
  ): TradeDecision {
    this.recordAudit({
      auditId, timestamp: Date.now(), symbol: signal.symbol, side: signal.side,
      decision: 'NO_TRADE', confidence: score, riskPassed: false, blockedBy: 'low_confidence',
    });
    return { decision: 'NO_TRADE', confidence: score, volume: 0, reasons, auditId };
  }

  private recordAudit(audit: DecisionAudit) {
    this.audits.push(audit);
    if (this.audits.length > this.MAX_AUDITS) this.audits.shift();
    // FIX [C7]: Write to dedicated table, not settings
    try {
      this.db.insertAudit(audit);
    } catch { /* non-critical — in-memory buffer always available */ }
  }

  // ─── Public utilities ─────────────────────────────────────────────────────

  /** Mark execution result and final risk state on an existing audit */
  markExecuted(auditId: string, ok: boolean, riskPassed: boolean, volume: number, tradeId?: number) {
    const audit = this.audits.find(a => a.auditId === auditId);
    if (audit) {
      audit.executedOk = ok;
      audit.riskPassed = riskPassed;
      audit.tradeId    = tradeId;
    }
    try {
      this.db.updateAudit(auditId, { executedOk: ok, riskPassed, tradeId });
    } catch { /* non-critical */ }
  }

  updateWinRates(rates: Record<string, number>) {
    this.winRates = { ...this.winRates, ...rates };
    this.logger.info(`Win rates updated: ${JSON.stringify(rates)}`);
  }

  getRecentAudits(hours = 1): DecisionAudit[] {
    const cutoff = Date.now() - hours * 3_600_000;
    return this.audits.filter(a => a.timestamp >= cutoff);
  }

  getAudit(auditId: string): DecisionAudit | undefined {
    return this.audits.find(a => a.auditId === auditId);
  }
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }
