/**
 * TRADING ENGINE — v9.0 (FINAL)
 * ══════════════════════════════════════════════════════════════════════════
 * Integrates ALL v9 improvements:
 *   - CandlestickPatternEngine: confirms every signal with candle pattern
 *   - D1TrendBiasFilter: blocks counter-trend signals (major win rate boost)
 *   - TimeBasedWinRateFilter: adjusts size by hour/day historical performance
 *   - SpreadAdjustment: corrects SL/TP for actual spread
 *   - GapProtection: tightens SL before weekend
 *   - MultiLevelPartialTP: 30/30/40 split exit
 *   - SmartExitManager: dynamic exit based on momentum
 *   - DrawdownRecoveryMode: 5-level volume control
 *   - AdaptiveATRManager: dynamic ATR multipliers
 *   - SentimentEngine: news sentiment bias
 * ══════════════════════════════════════════════════════════════════════════
 */
import { EventEmitter }           from 'events';
import axios                      from 'axios';
import { SystemConfig, Timeframe, Candle, Signal } from '../types/trading.types';
import { MarketScanner }          from './MarketScanner';
import { MultiTimeframeConfirm }  from './MultiTimeframeConfirm';
import { StaleDataGuard }         from './StaleDataGuard';
import { Reconciler }             from './Reconciler';
import { D1TrendBiasFilter }      from './D1TrendBiasFilter';
import { AutoSymbolDiscovery }    from './AutoSymbolDiscovery';
import { PositionTracker }        from './PositionTracker';
import { RaceConditionSafety }    from './RaceConditionSafety';
import { RiskManager }            from '../risk/RiskManager';
import { WeekendGuard }           from '../risk/WeekendGuard';
import { TimeBasedWinRateFilter } from '../risk/TimeBasedFilter';
import { DrawdownRecoveryMode }   from '../risk/DrawdownRecoveryMode';
import { ExecutionGateway }       from '../execution/ExecutionGateway';
import { MultiLevelPartialTP }    from '../execution/MultiLevelPartialTP';
import { TrailingStop }           from '../execution/TrailingStop';
import { ScaleInManager }         from '../execution/ScaleInManager';
import { TimeBasedExit }          from '../execution/TimeBasedExit';
import { BreakevenManager }       from '../execution/BreakevenManager';
import { SmartExitManager }       from '../execution/SmartExitManager';
import { SpreadAdjustment, GapProtection } from '../execution/SpreadAdjustment';
import { TelegramBot }            from '../notifications/TelegramBot';
import { PerformanceTracker }     from '../analytics/PerformanceTracker';
import { WeeklyReport }           from '../analytics/WeeklyReport';
import { DatabaseManager }        from '../database/DatabaseManager';
import { SymbolValidator }        from '../utils/SymbolValidator';
import { DbBackup }               from '../utils/DbBackup';
import { EmergencyStop }          from '../integration/EmergencyStop';
import { EventRegistry }          from '../integration/EventRegistry';
import { Logger }                 from '../utils/Logger';
import { MLEnhancer }             from '../ml/MLEnhancer';
import { AdaptiveTuner }          from '../ai/AdaptiveTuner';
import { NvidiaAI }               from '../ai/NvidiaAI';
import { marketRegimeDetector }   from './MarketRegimeDetector';
import { SignalQualityScorer }    from './SignalQualityScorer';
import { DataQualityGate }       from './DataQualityGate';
import { ConsensusOrchestrator }  from '../consensus/ConsensusOrchestrator';
import { ConsensusConfig }        from '../consensus/types';
import { CandlestickPatternEngine } from '../engines/CandlestickPatternEngine';
import { AdaptiveATRManager }     from '../optimization/AdaptiveATRManager';
import { SentimentEngine }        from '../sentiment/SentimentEngine';
import { AITradeJournal }         from '../journal/AITradeJournal';
import { getSymbolSpec }         from '../config/symbolConfig';

type Broadcaster = (event: string, data: unknown) => void;

const MAX_CONCURRENT_SYMBOLS = 3;

export class TradingEngine extends EventEmitter {
  private readonly logger      = new Logger('TradingEngine');
  private isRunning            = false;
  private ready                 = false;
  private timer: NodeJS.Timeout | null = null;
  private lastTradeAt: Record<string, number> = {};

  /*
   * ─── NEW: Runtime observability / heartbeat metrics ───────────────────────
   * These fields do not alter trading decisions or execution logic.
   */
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private cycleCount = 0;
  private consensusDecisionCount = 0;
  private signalCandidateCount = 0;
  private paperTradeCount = 0;
  private lastCycleAt = 0;
  private lastCycleDurationMs = 0;

  private broadcast: Broadcaster = () => {};

  private readonly mlEnhancer: MLEnhancer;
  private readonly dataQuality = new DataQualityGate();
  private readonly qualityScorer    = new SignalQualityScorer();
  private readonly candlePatterns   = new CandlestickPatternEngine();
  private readonly spreadAdj        = new SpreadAdjustment();
  private readonly gapProtect       = new GapProtection();
  private nvidiaAI: NvidiaAI;

  public h4Cache:   Record<string, Candle[]> = {};
  public d1Cache:   Record<string, Candle[]> = {};
  public candleMap: Record<string, Candle[]> = {};

  private readonly scanner:       MarketScanner;
  private readonly consensus:     ConsensusOrchestrator;
  private readonly risk:          RiskManager;
  private readonly exec:          ExecutionGateway;
  private readonly mtf:           MultiTimeframeConfirm;
  private readonly stale:         StaleDataGuard;
  private readonly reconciler:    Reconciler;
  private readonly tracker:       PerformanceTracker;
  private readonly multiTP:       MultiLevelPartialTP;
  private readonly trailing:      TrailingStop;
  private readonly scaleIn:       ScaleInManager;
  private readonly timeExit:      TimeBasedExit;
  private readonly breakeven:     BreakevenManager;
  private readonly smartExit:     SmartExitManager;
  private readonly adaptiveTuner: AdaptiveTuner;
  private readonly weeklyReport:  WeeklyReport;
  private readonly dbBackup:      DbBackup;
  private readonly validator:     SymbolValidator;
  private readonly emergency:     EmergencyStop;
  private readonly weekendGuard:  WeekendGuard;
  private readonly events:        EventRegistry;
  private readonly posTracker:    PositionTracker;
  private readonly raceSafety:    RaceConditionSafety;
  private readonly d1Bias:        D1TrendBiasFilter;
  private readonly timeFilter:    TimeBasedWinRateFilter;
  private readonly recoveryMode:  DrawdownRecoveryMode;
  private readonly adaptiveATR:   AdaptiveATRManager;
  private readonly sentiment:     SentimentEngine;
  public  tradeJournal:           AITradeJournal;

  public readonly telegram:  TelegramBot;
  public validSymbols: string[] = [];

  constructor(public readonly config: SystemConfig, public readonly db: DatabaseManager) {
    super();

    this.telegram     = new TelegramBot(config);
    this.emergency    = new EmergencyStop(this.telegram);
    this.mlEnhancer   = new MLEnhancer(config, db);
    this.scanner      = new MarketScanner(config);
    this.exec         = new ExecutionGateway(config, db);
    this.tracker      = new PerformanceTracker(db, config);
    this.validator    = new SymbolValidator(config);
    this.events       = new EventRegistry();
    this.nvidiaAI     = new NvidiaAI(config);
    this.posTracker   = new PositionTracker(db);
    this.raceSafety   = new RaceConditionSafety();
    this.d1Bias       = new D1TrendBiasFilter();
    this.timeFilter   = new TimeBasedWinRateFilter(db);
    this.adaptiveATR  = new AdaptiveATRManager(db);
    this.sentiment    = new SentimentEngine();
    this.tradeJournal = new AITradeJournal(db, this.telegram);
    this.recoveryMode = new DrawdownRecoveryMode(db, this.telegram, config.accountBalance);

    const consensusCfg: Partial<ConsensusConfig> = {
      minimum_total_weight:      config.consensus?.minimumTotalWeight      ?? 0.25,
      dominance_ratio:           config.consensus?.dominanceRatio          ?? 0.60,
      minimum_active_strategies: config.consensus?.minimumActiveStrategies ?? 1,
      rolling_window_size:       config.consensus?.rollingWindowSize       ?? 30,
      gate: {
        min_win_rate:           config.consensus?.gate?.minWinRate           ?? 0.48,
        min_sharpe_ratio:       config.consensus?.gate?.minSharpeRatio       ?? 0.80,
        min_rolling_expectancy: config.consensus?.gate?.minRollingExpectancy ?? 0.00,
        max_drawdown:           config.consensus?.gate?.maxDrawdown          ?? 0.22,
        min_trades_for_gate:    config.consensus?.gate?.minTradesForGate     ?? 20,
      },
    };

    this.consensus = new ConsensusOrchestrator(db, consensusCfg);
    this.risk      = new RiskManager(config, db, this.telegram, this.emergency);
    this.adaptiveTuner = new AdaptiveTuner(db, this.consensus.registry as any, config);

    this.mtf          = new MultiTimeframeConfirm(this.scanner);
    this.stale        = new StaleDataGuard();
    this.weekendGuard = new WeekendGuard(config, db, this.exec, this.telegram);
    this.weeklyReport = new WeeklyReport(db, this.telegram);
    this.smartExit    = new SmartExitManager(config, db, this.scanner, this.exec);

    this.reconciler = new Reconciler(
      config, db, this.exec, this.telegram, this.tracker, this.scanner, this.emergency,
      async (trade) => {
        if (trade.source) {
          this.consensus.recordClose(
            trade.source,
            trade.profit ?? 0,
            trade.entry,
            (trade as any).exitPrice ?? trade.entry
          );
        }

        this.risk.recordClose(trade.profit ?? 0);
        this.posTracker.recordClose(trade.symbol);

        // Journal entry
        await this.tradeJournal.record(trade as any).catch(() => {});

        this.broadcast('trade_closed', trade);
        this.events.emit('trade:closed', trade);
      },
    );

    this.multiTP  = new MultiLevelPartialTP(config, db, this.exec, this.scanner);
    this.trailing = new TrailingStop(config, db, this.scanner, this.exec);
    this.scaleIn  = new ScaleInManager(config, db, this.exec, this.scanner);
    this.timeExit = new TimeBasedExit(config, db, this.exec, this.scanner, this.telegram);
    this.breakeven = new BreakevenManager(config, db, this.scanner);

    this.dbBackup = new DbBackup(
      db.path,
      config.s3Backup?.enabled ? {
        endpoint:  config.s3Backup.endpoint,
        bucket:    config.s3Backup.bucket,
        accessKey: config.s3Backup.accessKey,
        secretKey: config.s3Backup.secretKey,
        region:    config.s3Backup.region,
      } : undefined,
      config.s3Backup?.encryptionKey,
    );
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  setBroadcaster(b: Broadcaster) { this.broadcast = b; }
  get emergencyStop() { return this.emergency; }

  async start() {
    if (this.isRunning) return;

    this.ready = false;
    this.logger.info('Starting TradingEngine v9.0...');

    await this.exec.initialize();

    this.validSymbols = await this.validator.validate();

    if (this.validSymbols.length === 0) {
      throw new Error(
        '[Startup] No valid market symbols available; refusing to mark the trading engine ready'
      );
    }

    await this.risk.refreshNews();
    this.posTracker.syncFromDB();

    this.isRunning = true;
    this.ready = true;

    this.reconciler.start();
    this.weekendGuard.start();
    this.multiTP.start();
    this.trailing.start();
    this.scaleIn.start();
    this.timeExit.start();
    this.breakeven.start();
    this.smartExit.start();
    this.adaptiveTuner.start();
    this.weeklyReport.start();
    this.dbBackup.start();

    const csStatus = this.consensus.getStatus();

    await this.telegram.sendMessage(
      `🚀 <b>Trading Bot v9.0</b>\n` +
      `Mode: ${this.config.mode.toUpperCase()} | Symbols: ${this.validSymbols.length}\n` +
      `🧠 Strategies: ${csStatus.active_count} active | 📊 Positions: ${this.posTracker.count()}\n` +
      `✨ v9: Candlestick + D1 Bias + TimeFilter + SmartExit + MultiTP`
    ).catch(() => {});

    this.broadcast('engine', { running: true });

    this.cycle().catch(e => this.logger.error('cycle', e));

    this.timer = setInterval(
      () => this.cycle().catch(e => this.logger.error('cycle', e)),
      this.config.scanInterval,
    );

    /*
     * ─── NEW: Heartbeat every 5 minutes ─────────────────────────────────────
     * This only reports runtime state; it does not alter the trading engine.
     */
    this.heartbeatTimer = setInterval(
      () => this.logHeartbeat(),
      5 * 60_000,
    );

    // Emit one immediate heartbeat after startup.
    this.logHeartbeat();
  }

  async stop() {
    this.isRunning = false;
    this.ready = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.reconciler.stop();
    this.weekendGuard.stop();
    this.multiTP.stop();
    this.trailing.stop();
    this.scaleIn.stop();
    this.timeExit.stop();
    this.breakeven.stop();
    this.smartExit.stop();
    this.adaptiveTuner.stop();
    this.weeklyReport.stop();
    this.dbBackup.stop();

    await this.telegram.sendMessage('🛑 Trading bot v9.0 stopped').catch(() => {});

    this.broadcast('engine', { running: false });
  }

  isActive() {
    return this.isRunning;
  }

  isReady() {
    return this.isRunning && this.ready && this.validSymbols.length > 0;
  }

  readiness() {
    return {
      ready: this.isReady(),
      running: this.isRunning,
      symbols: this.validSymbols.length,
      mode: this.config.mode,
    };
  }

  // ─── Main cycle ───────────────────────────────────────────────────────────

  private async cycle() {
    const cycleStartedAt = Date.now();

    this.cycleCount += 1;

    try {
      if (!this.isRunning || this.emergency.isActive()) return;

      await this.risk.refreshNews().catch(() => {});
      await this.sentiment.refreshData().catch(() => {});

      const symbols = this.validSymbols.length
        ? this.validSymbols
        : this.config.symbols;

      for (let i = 0; i < symbols.length; i += MAX_CONCURRENT_SYMBOLS) {
        if (!this.isRunning || this.emergency.isActive()) return;

        const batch = symbols.slice(i, i + MAX_CONCURRENT_SYMBOLS);

        await Promise.allSettled(
          batch.map(symbol =>
            this.processSymbolAllTF(symbol).catch(e =>
              this.logger.error(`[${symbol}] batch error: ${e.message}`)
            )
          )
        );
      }
    } finally {
      this.lastCycleAt = Date.now();
      this.lastCycleDurationMs = Date.now() - cycleStartedAt;
    }
  }

  private async processSymbolAllTF(symbol: string) {
    await this.raceSafety.withLock(symbol, async () => {
      // Fetch D1 once per symbol per cycle
      let d1Ready = false;

      try {
        const d1 = await this.scanner.fetchCandles(symbol, 'D1', 250);

        if (d1.length >= 200) {
          this.d1Cache[symbol] = d1;
          d1Ready = true;
        }
      } catch (e: any) {
        this.logger.warn(
          `[${symbol}] D1 data unavailable; symbol blocked fail-closed: ${e?.message ?? e}`
        );
      }

      if (!d1Ready) return;

      for (const tf of this.config.timeframes) {
        if (!this.isRunning || this.emergency.isActive()) return;
        if (this.posTracker.hasOpenPosition(symbol)) return;

        try {
          await this.processSymbol(symbol, tf);
        } catch (e: any) {
          this.logger.error(`${symbol} ${tf}: ${e.message}`);
        }
      }
    }, 60_000);
  }

  private async processSymbol(symbol: string, tf: Timeframe) {
    const rateLimitKey = `${symbol}_${tf}`;

    if (
      Date.now() - (this.lastTradeAt[rateLimitKey] ?? 0) <
      5 * 60_000
    ) {
      return;
    }

    // ── [NEW] Time-based filter ────────────────────────────────────────
    if (this.timeFilter.shouldBlock()) return;

    const timeScore = this.timeFilter.getMultiplier();

    // ── [NEW] Drawdown Recovery check ─────────────────────────────────
    const equity = await this.exec.getCurrentEquity();

    if (!(equity != null && equity > 0 && Number.isFinite(equity))) {
      this.logger.error(
        `[${symbol}/${tf}] Current equity unavailable — fail-closed`
      );
      return;
    }

    const recoveryState = this.recoveryMode.evaluate(equity);

    if (recoveryState.level === 'STOP') return;

    const candles = await this.scanner.fetchCandles(symbol, tf, 250);

    if (candles.length < 220) return;

    this.candleMap[symbol] = candles;

    const dataQuality = this.dataQuality.validate(candles, tf);

    if (!dataQuality.ok) {
      this.logger.warn(
        `[${symbol}/${tf}] Data quality blocked: ${
          dataQuality.reasons.slice(0, 5).join(', ')
        }`
      );
      return;
    }

    const fresh = this.stale.isFresh(candles, tf);

    if (!fresh.ok) return;

    const regime = marketRegimeDetector.detect(symbol, tf, candles);

    if (regime.regime === 'VOLATILE') return;

    if (tf === 'H4') {
      this.h4Cache[symbol] = candles;
    }

    const h4Candles = this.h4Cache[symbol] ?? [];
    const d1Candles = this.d1Cache[symbol] ?? [];

    // ── [NEW] Adaptive ATR ─────────────────────────────────────────────
    this.adaptiveATR.getParams(symbol, candles);

    // ── Consensus ─────────────────────────────────────────────────────
    const consensus = this.consensus.process(
      symbol,
      candles,
      h4Candles,
      regime.regime
    );

    /*
     * ─── NEW: runtime metric ───────────────────────────────────────────────
     * Count every completed consensus decision.
     */
    this.consensusDecisionCount += 1;

    this.broadcast('consensus', {
      symbol,
      tf,
      outcome: consensus.outcome,
      block_reason: consensus.block_reason,
    });

    if (consensus.outcome === 'NO_TRADE' || !consensus.signal) return;

    /*
     * ─── NEW: runtime metric ───────────────────────────────────────────────
     * A candidate signal means consensus produced an actionable signal
     * that passed the NO_TRADE / missing-signal gate.
     */
    this.signalCandidateCount += 1;

    let signal: Signal = consensus.signal;

    this.db.insertSignal(signal);

    if (!this.consensus.isKnownStrategySource(signal.source)) {
      this.logger.error(
        `Unknown or inactive strategy source blocked: ${signal.source}`
      );
      return;
    }

    // ── [NEW] D1 Trend Bias Filter ─────────────────────────────────────
    const d1bias = this.d1Bias.evaluate(
      symbol,
      signal.side,
      signal.source,
      d1Candles
    );

    if (!d1bias.allows) {
      this.logger.info(
        `D1 bias blocked ${symbol} ${signal.side}: ${d1bias.reason}`
      );
      return;
    }

    signal = {
      ...signal,
      confidence: Math.min(
        0.95,
        signal.confidence * d1bias.confidMult
      ),
    };

    // ── MTF confirmation ───────────────────────────────────────────────
    const mtfOk = tf === 'H4'
      ? true
      : await this.mtf.confirm(symbol, signal.side);

    if (!mtfOk) return;

    // ── [NEW] Candlestick Pattern confirmation ─────────────────────────
    const pattern = this.candlePatterns.analyze(candles, signal.side);

    if (pattern.conflictsBias && pattern.strength === 'STRONG') {
      this.logger.info(
        `Candle pattern blocks ${symbol}: ${pattern.name}`
      );
      return;
    }

    if (pattern.found) {
      signal = {
        ...signal,
        confidence: Math.min(
          0.95,
          signal.confidence + pattern.boost
        ),
      };
    }

    // ── [NEW] Sentiment bias ───────────────────────────────────────────
    const sent = await this.sentiment.getSentiment(symbol).catch(() => null);

    if (sent?.bias && sent.impact === 'STRONG') {
      if (sent.bias !== signal.side && sent.bias !== 'NONE') {
        this.logger.info(
          `Sentiment blocks ${symbol} ${signal.side}: ${sent.reason}`
        );
        return;
      }

      if (sent.bias === signal.side) {
        signal = {
          ...signal,
          confidence: Math.min(
            0.95,
            signal.confidence + 0.03
          ),
        };
      }
    }

    // ── ML Enhancement ─────────────────────────────────────────────────
    const mlSignal = await this.mlEnhancer.enhance(
      signal,
      candles,
      h4Candles,
      tf
    );

    let aiMul = 1.0;

    try {
      aiMul = await this.nvidiaAI.scoreSignal(mlSignal);
    } catch (e: any) {
      if (this.config.mode !== 'paper' || this.config.mlRequired) {
        this.logger.warn(
          `NVIDIA AI advisory unavailable; fail-closed: ${
            e?.message ?? e
          }`
        );
        return;
      }

      this.logger.warn(
        `NVIDIA AI advisory unavailable; paper-mode fallback: ${
          e?.message ?? e
        }`
      );
    }

    const finalSignal: Signal = {
      ...mlSignal,
      confidence: Math.min(
        0.95,
        mlSignal.confidence * aiMul
      ),
    };

    // ── Quality gate ───────────────────────────────────────────────────
    const sourceWR = this.getSourceWinRate(finalSignal.source);

    const quality = this.qualityScorer.score(
      finalSignal,
      candles,
      regime.regime,
      sourceWR
    );

    if (quality.grade === 'F') return;

    // ── [NEW] Spread adjustment ────────────────────────────────────────
    const ticker = await this.fetchTicker(symbol);

    let adjustedSignal = finalSignal;

    if (ticker) {
      const spread = ticker.ask - ticker.bid;
      adjustedSignal = this.spreadAdj.adjust(adjustedSignal, spread);
    }

    // ── Recovery mode: strategy filter ────────────────────────────────
    if (recoveryState.allowedStrategies) {
      const allowed = this.recoveryMode.isStrategyAllowed(
        adjustedSignal.source,
        recoveryState
      );

      if (!allowed) {
        this.logger.info(
          `Recovery ${recoveryState.level}: blocks ${adjustedSignal.source}`
        );
        return;
      }
    }

    // ── Risk pipeline ──────────────────────────────────────────────────
    const openTrades = this.db.getOpenTrades();

    const livePrices = ticker
      ? { [symbol]: (ticker.bid + ticker.ask) / 2 }
      : {};

    const risk = await this.risk.check(
      adjustedSignal,
      openTrades,
      ticker ?? undefined,
      equity,
      quality.total,
      livePrices,
      this.candleMap,
    );

    if (!risk.passed) return;

    // ── [NEW] Apply time & recovery volume multipliers ─────────────────
    // Re-normalize the risk-approved volume after time/recovery multipliers.
    // Do not hard-code 0.01: crypto/indices can use 0.001 or integer steps.
    const spec = getSymbolSpec(symbol);

    const rawVolume =
      risk.volume *
      timeScore.multiplier *
      recoveryState.volumeMultiplier;

    const stepped =
      Math.floor(
        rawVolume / spec.volumeStep + 1e-12
      ) * spec.volumeStep;

    const adjustedVolume = Math.min(
      spec.maxVolume,
      Math.max(
        0,
        Number(stepped.toFixed(8))
      )
    );

    // Re-apply the absolute risk cap after every adaptive/time/recovery modifier.
    const volume = this.risk.getSizer().capToAbsoluteRisk(
      symbol,
      adjustedSignal.price,
      adjustedSignal.sl,
      adjustedVolume,
      equity
    );

    if (!(volume > 0)) return;

    // ── Final duplicate check ──────────────────────────────────────────
    if (this.posTracker.hasOpenPosition(symbol)) return;

    // ── Execute ────────────────────────────────────────────────────────
    const result = await this.exec.execute(
      adjustedSignal,
      volume,
      tf
    );

    if (result.success && result.trade) {
      this.lastTradeAt[rateLimitKey] = Date.now();

      this.posTracker.recordOpen(
        symbol,
        adjustedSignal.side,
        tf,
        adjustedSignal.source
      );

      /*
       * ─── NEW: paper execution metric ─────────────────────────────────────
       * Count only successful paper trades.
       */
      if (this.config.mode === 'paper') {
        this.paperTradeCount += 1;
      }

      const patternStr =
        pattern.found
          ? ` | ${pattern.name}`
          : '';

      const d1str =
        d1bias.trend !== 'NEUTRAL'
          ? ` | D1 ${d1bias.trend}`
          : '';

      await this.telegram.sendMessage(
        `✅ <b>${result.trade.side} ${result.trade.symbol}</b> [${tf}]\n` +
        `Vol: ${volume} @ ${result.trade.entry}\n` +
        `SL: ${result.trade.sl.toFixed(5)} | TP: ${result.trade.tp.toFixed(5)}\n` +
        `📊 Regime: ${regime.regime} | Q: ${quality.total}/100 (${quality.grade})\n` +
        `🧠 ${consensus.votes.length} voters | dom=${consensus.dominance_ratio.toFixed(2)}\n` +
        `🕯 ${patternStr}${d1str} | 🕐 ×${timeScore.multiplier} | 🛡 ${recoveryState.level}`
      ).catch(() => {});

      this.events.emit('trade:opened', result.trade);
      this.broadcast('trade_open', result.trade);
    }
  }

  // ─── NEW: Heartbeat / runtime observability ───────────────────────────────

  private logHeartbeat() {
    const lastCycle =
      this.lastCycleAt > 0
        ? new Date(this.lastCycleAt).toISOString()
        : 'never';

    const symbols =
      this.validSymbols.length > 0
        ? this.validSymbols.join(',')
        : 'none';

    let openPositions = 0;

    try {
      openPositions = this.posTracker.count();
    } catch {
      openPositions = 0;
    }

    this.logger.info(
      `[Heartbeat] ` +
      `running=${this.isRunning} ` +
      `ready=${this.isReady()} ` +
      `mode=${this.config.mode} ` +
      `symbols=${symbols} ` +
      `cycles=${this.cycleCount} ` +
      `consensus=${this.consensusDecisionCount} ` +
      `signals=${this.signalCandidateCount} ` +
      `paperTrades=${this.paperTradeCount} ` +
      `openPositions=${openPositions} ` +
      `lastCycle=${lastCycle} ` +
      `lastCycleMs=${this.lastCycleDurationMs}`
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async fetchTicker(
    symbol: string
  ): Promise<{ bid: number; ask: number } | null> {
    try {
      const useMt5 =
        this.config.mode === 'mt5' ||
        (
          this.config.mode === 'paper' &&
          this.config.dataSource === 'mt5'
        );

      if (useMt5) {
        const r = await axios.get(
          `${this.config.mt5.bridgeUrl}/tick`,
          {
            params: { symbol },
            timeout: 3000,
            headers: this.config.mt5.bridgeApiKey
              ? { 'X-Api-Key': this.config.mt5.bridgeApiKey }
              : {},
          }
        );

        return {
          bid: Number(r.data.bid),
          ask: Number(r.data.ask),
        };
      }

      const base = this.config.binance.futures
        ? (
            this.config.binance.env === 'testnet'
              ? 'https://testnet.binancefuture.com/fapi/v1/ticker/bookTicker'
              : 'https://fapi.binance.com/fapi/v1/ticker/bookTicker'
          )
        : (
            this.config.binance.env === 'testnet'
              ? 'https://testnet.binance.vision/api/v3/ticker/bookTicker'
              : 'https://api.binance.com/api/v3/ticker/bookTicker'
          );

      const r = await axios.get(
        base,
        {
          params: { symbol },
          timeout: 3000,
        }
      );

      return {
        bid: Number(r.data.bidPrice),
        ask: Number(r.data.askPrice),
      };
    } catch {
      return null;
    }
  }

  private getSourceWinRate(source: string): number {
    try {
      const primary = source.split('+')[0];

      const cutoff =
        Date.now() - 30 * 24 * 3_600_000;

      const row = this.db.raw().prepare(
        `SELECT COUNT(*) total,
                SUM(CASE WHEN profit>0 THEN 1 ELSE 0 END) wins
         FROM trades
         WHERE status='closed'
           AND source LIKE ?
           AND openedAt > ?`
      ).get(
        `%${primary}%`,
        cutoff
      ) as {
        total: number;
        wins: number;
      } | undefined;

      if (!row || row.total < 10) {
        return 0.50;
      }

      return row.wins / row.total;
    } catch {
      return 0.50;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  getRiskStatus() {
    return this.risk.getCircuitBreakerStatus();
  }

  getPerformanceSummary() {
    return this.tracker.summary();
  }

  getEventRegistry() {
    return this.events;
  }

  getConsensusStatus() {
    return this.consensus.getStatus();
  }

  getConsensusLog(n = 50) {
    return this.consensus.getRecentLog(n);
  }

  getPositionSummary() {
    return this.posTracker.summary();
  }

  getRaceSafetyStats() {
    return this.raceSafety.getStats();
  }

  /*
   * ─── NEW: Public runtime metrics ─────────────────────────────────────────
   * Read-only snapshot for API/dashboard/debugging.
   */
  getRuntimeMetrics() {
    return {
      running: this.isRunning,
      ready: this.isReady(),
      mode: this.config.mode,
      symbols: [...this.validSymbols],
      cycleCount: this.cycleCount,
      consensusDecisionCount: this.consensusDecisionCount,
      signalCandidateCount: this.signalCandidateCount,
      paperTradeCount: this.paperTradeCount,
      lastCycleAt: this.lastCycleAt > 0
        ? new Date(this.lastCycleAt).toISOString()
        : null,
      lastCycleDurationMs: this.lastCycleDurationMs,
      openPositions: (() => {
        try {
          return this.posTracker.count();
        } catch {
          return 0;
        }
      })(),
    };
  }

  async triggerEmergencyStop(r: string) {
    await this.emergency.activate(r);
  }

  async resumeTrading(approver: string) {
    await this.emergency.deactivate(approver);
  }
}