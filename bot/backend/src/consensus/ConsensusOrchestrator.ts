/**
 * CONSENSUS ORCHESTRATOR — v7.1
 * [FIX] يُسجّل جميع الاستراتيجيات الثماني (V6 + V7) عند التهيئة
 * [FIX] يُمرر h4Candles و regime إلى StrategyContext بشكل صحيح
 * [NEW] getRecentLog() يعيد آخر N سجلات مع الـ votes
 * [NEW] يحفظ كل نتيجة في DB عبر saveConsensusLog()
 */
import { DatabaseManager }          from '../database/DatabaseManager';
import { StrategyRegistry }         from './StrategyRegistry';
import { StrategyConsensusEngine }  from './StrategyConsensusEngine';
import { createAllAdapters }        from './StrategyAdapters';
import { ConsensusConfig, ConsensusResult, StrategyContext } from './types';
import { ConsensusLogger } from './ConsensusLogger';
import { Candle, Timeframe, Mode } from '../types/trading.types';

export interface LogEntry extends ConsensusResult {
  symbol: string;
  savedAt: number;
}

export class ConsensusOrchestrator {
  readonly registry: StrategyRegistry;
  private readonly engine: StrategyConsensusEngine;
  private readonly recentLog: LogEntry[] = [];
  private readonly consensusLogger: ConsensusLogger;
  private readonly MAX_LOG = 200;

  constructor(
    private readonly db:  DatabaseManager,
    cfg: Partial<ConsensusConfig> = {},
  ) {
    this.registry = new StrategyRegistry(db, cfg);

    // [FIX] Register all 8 strategies
    for (const adapter of createAllAdapters()) {
      this.registry.register(adapter);
    }

    this.engine = new StrategyConsensusEngine(this.registry, cfg);
    this.consensusLogger = new ConsensusLogger(db);
  }

  process(
    symbol:    string,
    candles:   Candle[],
    h4Candles: Candle[],
    regime:    string,
    timeframe: Timeframe = 'H1',
  ): ConsensusResult {
    // [FIX] Build full StrategyContext with all required fields
    const ctx: StrategyContext = {
      symbol,
      timeframe,
      candles,
      h4Candles,
      regime:    regime as any,
      timestamp: Date.now(),
    };

    const result = this.engine.run(ctx);

    // Log structured event
    this.consensusLogger.log(result as any);

    // [NEW] Save to DB for audit trail
    this.db.saveConsensusLog({
      symbol,
      outcome:      result.outcome,
      block_reason: result.block_reason,
      buy_weight:   result.total_buy_weight,
      sell_weight:  result.total_sell_weight,
      dominance:    result.dominance_ratio,
      active_strats: result.active_strategies,
      voters:       result.votes.length,
      duration_ms:  result.duration_ms,
      reasoning:    result.reasoning.at(-1),
      timestamp:    result.timestamp,
    });

    // In-memory log (last MAX_LOG)
    this.recentLog.push({ ...result, symbol, savedAt: Date.now() });
    if (this.recentLog.length > this.MAX_LOG) {
      this.recentLog.splice(0, this.recentLog.length - this.MAX_LOG);
    }

    return result;
  }

  /** Called after a trade closes — updates strategy metrics */
  recordClose(source: string, profit: number, entry: number, exitPrice: number): void {
    const names = source.split('+').map(s => s.trim());
    for (const name of names) {
      this.registry.recordTrade(name, profit, entry, exitPrice);
    }
  }

  isKnownStrategySource(source: string): boolean {
    const names = source.split('+').map(s => s.trim()).filter(Boolean);
    if (!names.length) return false;
    return names.every(name => {
      const entry = this.registry.getAll().get(name);
      return !!entry && entry.enabled;
    });
  }

  isExecutionLifecycleEligible(source: string, mode: Mode): { allowed: boolean; reason: string } {
    const names = source.split('+').map(s => s.trim()).filter(Boolean);
    if (!names.length) return { allowed: false, reason: 'empty strategy source' };

    const required =
      mode === 'paper' ? 'PAPER' :
      'PRODUCTION';

    const rank: Record<string, number> = {
      RESEARCH: 0,
      BACKTEST: 1,
      VALIDATION: 2,
      WALK_FORWARD: 3,
      MONTE_CARLO: 4,
      PAPER: 5,
      TESTNET: 6,
      SHADOW: 7,
      SMALL_CAPITAL: 8,
      PRODUCTION: 9,
      PAUSED: -1,
      REJECTED: -1,
    };

    for (const name of names) {
      const definition = this.registry.getDefinition(name);

      // Existing strategies without metadata remain compatible in paper mode.
      if (!definition) {
        if (mode !== 'paper') {
          return {
            allowed: false,
            reason: `strategy ${name} has no lifecycle definition for non-paper execution`,
          };
        }
        continue;
      }

      if (definition.lifecycle === 'PAUSED' || definition.lifecycle === 'REJECTED') {
        return {
          allowed: false,
          reason: `strategy ${name} lifecycle=${definition.lifecycle}`,
        };
      }

      if (rank[definition.lifecycle] < rank[required]) {
        return {
          allowed: false,
          reason: `strategy ${name} lifecycle=${definition.lifecycle} requires >= ${required}`,
        };
      }
    }

    return { allowed: true, reason: 'strategy lifecycle eligible' };
  }

  getStatus() {
    const snap   = this.registry.getSnapshot();
    const active = this.registry.getActive();
    return {
      active_count:    active.length,
      total_count:     Object.keys(snap).length,
      strategies:      snap,
      disabled:        this.registry.getDisabled(),
      last_log_entry:  this.recentLog.at(-1) ?? null,
    };
  }

  getRecentLog(n = 50): LogEntry[] {
    return this.recentLog.slice(-n);
  }
}
