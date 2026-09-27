/**
 * TRADING ENGINE — v9.0 (DIAGNOSTIC / PAPER READY)
 * ══════════════════════════════════════════════════════════════════════════
 * Integrates:
 *   - CandlestickPatternEngine
 *   - D1TrendBiasFilter
 *   - TimeBasedWinRateFilter
 *   - SpreadAdjustment
 *   - GapProtection
 *   - MultiLevelPartialTP
 *   - SmartExitManager
 *   - DrawdownRecoveryMode
 *   - AdaptiveATRManager
 *   - SentimentEngine
 *
 * Diagnostic additions:
 *   - Pipeline block/pass logs
 *   - MTF diagnostic result
 *   - Risk diagnostic result
 *   - Volume diagnostic result
 *   - Execution diagnostic result
 *
 * IMPORTANT:
 *   Diagnostic logging does not loosen or bypass trading/risk rules.
 * ══════════════════════════════════════════════════════════════════════════
 */

import { EventEmitter } from 'events';
import axios from 'axios';

import {
  SystemConfig,
  Timeframe,
  Candle,
  Signal,
} from '../types/trading.types';

import { MarketScanner } from './MarketScanner';
import { MultiTimeframeConfirm } from './MultiTimeframeConfirm';
import { StaleDataGuard } from './StaleDataGuard';
import { Reconciler } from './Reconciler';
import { D1TrendBiasFilter } from './D1TrendBiasFilter';
import { AutoSymbolDiscovery } from './AutoSymbolDiscovery';
import { PositionTracker } from './PositionTracker';
import { RaceConditionSafety } from './RaceConditionSafety';

import { RiskManager } from '../risk/RiskManager';
import { WeekendGuard } from '../risk/WeekendGuard';
import { TimeBasedWinRateFilter } from '../risk/TimeBasedFilter';
import { DrawdownRecoveryMode } from '../risk/DrawdownRecoveryMode';

import { ExecutionGateway } from '../execution/ExecutionGateway';
import { MultiLevelPartialTP } from '../execution/MultiLevelPartialTP';
import { TrailingStop } from '../execution/TrailingStop';
import { ScaleInManager } from '../execution/ScaleInManager';
import { TimeBasedExit } from '../execution/TimeBasedExit';
import { BreakevenManager } from '../execution/BreakevenManager';
import { SmartExitManager } from '../execution/SmartExitManager';
import {
  SpreadAdjustment,
  GapProtection,
} from '../execution/SpreadAdjustment';

import { TelegramBot } from '../notifications/TelegramBot';
import { PerformanceTracker } from '../analytics/PerformanceTracker';
import { WeeklyReport } from '../analytics/WeeklyReport';

import { DatabaseManager } from '../database/DatabaseManager';
import { SymbolValidator } from '../utils/SymbolValidator';
import { DbBackup } from '../utils/DbBackup';

import { EmergencyStop } from '../integration/EmergencyStop';
import { EventRegistry } from '../integration/EventRegistry';

import { Logger } from '../utils/Logger';

import { MLEnhancer } from '../ml/MLEnhancer';
import { AdaptiveTuner } from '../ai/AdaptiveTuner';
import { NvidiaAI } from '../ai/NvidiaAI';

import { marketRegimeDetector } from './MarketRegimeDetector';
import { SignalQualityScorer } from './SignalQualityScorer';
import { DataQualityGate } from './DataQualityGate';

import { ConsensusOrchestrator } from '../consensus/ConsensusOrchestrator';
import { ConsensusConfig } from '../consensus/types';

import { CandlestickPatternEngine } from '../engines/CandlestickPatternEngine';
import { AdaptiveATRManager } from '../optimization/AdaptiveATRManager';

import { SentimentEngine } from '../sentiment/SentimentEngine';
import { AITradeJournal } from '../journal/AITradeJournal';

import { getSymbolSpec } from '../config/symbolConfig';

type Broadcaster = (event: string, data: unknown) => void;

const MAX_CONCURRENT_SYMBOLS = 3;

export class TradingEngine extends EventEmitter {
  private readonly logger = new Logger('TradingEngine');

  private isRunning = false;
  private ready = false;

  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private lastTradeAt: Record<string, number> = {};

  // ─── Runtime observability ────────────────────────────────────────────────
  private cycleCount = 0;
  private consensusDecisionCount = 0;
  private signalCandidateCount = 0;
  private paperTradeCount = 0;

  private lastCycleAt = 0;
  private lastCycleDurationMs = 0;

  private broadcast: Broadcaster = () => {};

  // ─── Engines / services ───────────────────────────────────────────────────
  private readonly mlEnhancer: MLEnhancer;

  private readonly dataQuality = new DataQualityGate();
  private readonly qualityScorer = new SignalQualityScorer();
  private readonly candlePatterns = new CandlestickPatternEngine();

  private readonly spreadAdj = new SpreadAdjustment();
  private readonly gapProtect = new GapProtection();

  private nvidiaAI: NvidiaAI;

  public h4Cache: Record<string, Candle[]> = {};
  public d1Cache: Record<string, Candle[]> = {};
  public candleMap: Record<string, Candle[]> = {};

  private readonly scanner: MarketScanner;
  private readonly consensus: ConsensusOrchestrator;
  private readonly risk: RiskManager;
  private readonly exec: ExecutionGateway;

  private readonly mtf: MultiTimeframeConfirm;
  private readonly stale: StaleDataGuard;
  private readonly reconciler: Reconciler;

  private readonly tracker: PerformanceTracker;

  private readonly multiTP: MultiLevelPartialTP;
  private readonly trailing: TrailingStop;
  private readonly scaleIn: ScaleInManager;
  private readonly timeExit: TimeBasedExit;
  private readonly breakeven: BreakevenManager;
  private readonly smartExit: SmartExitManager;

  private readonly adaptiveTuner: AdaptiveTuner;
  private readonly weeklyReport: WeeklyReport;
  private readonly dbBackup: DbBackup;

  private readonly validator: SymbolValidator;
  private readonly emergency: EmergencyStop;
  private readonly weekendGuard: WeekendGuard;
  private readonly events: EventRegistry;

  private readonly posTracker: PositionTracker;
  private readonly raceSafety: RaceConditionSafety;

  private readonly d1Bias: D1TrendBiasFilter;
  private readonly timeFilter: TimeBasedWinRateFilter;
  private readonly recoveryMode: DrawdownRecoveryMode;

  private readonly adaptiveATR: AdaptiveATRManager;
  private readonly sentiment: SentimentEngine;

  public tradeJournal: AITradeJournal;

  public readonly telegram: TelegramBot;
  public validSymbols: string[] = [];

  constructor(
    public readonly config: SystemConfig,
    public readonly db: DatabaseManager,
  ) {
    super();

    this.telegram = new TelegramBot(config);
    this.emergency = new EmergencyStop(this.telegram);

    this.mlEnhancer = new MLEnhancer(config, db);
    this.scanner = new MarketScanner(config);
    this.exec = new ExecutionGateway(config, db);

    this.tracker = new PerformanceTracker(db, config);
    this.validator = new SymbolValidator(config);

    this.events = new EventRegistry();

    this.nvidiaAI = new NvidiaAI(config);

    this.posTracker = new PositionTracker(db);
    this.raceSafety = new RaceConditionSafety();

    this.d1Bias = new D1TrendBiasFilter();
    this.timeFilter = new TimeBasedWinRateFilter(db);

    this.adaptiveATR = new AdaptiveATRManager(db);
    this.sentiment = new SentimentEngine();

    this.tradeJournal = new AITradeJournal(db, this.telegram);

    this.recoveryMode = new DrawdownRecoveryMode(
      db,
      this.telegram,
      config.accountBalance,
    );

    const consensusCfg: Partial<ConsensusConfig> = {
      minimum_total_weight:
        config.consensus?.minimumTotalWeight ?? 0.25,

      dominance_ratio:
        config.consensus?.dominanceRatio ?? 0.60,

      minimum_active_strategies:
        config.consensus?.minimumActiveStrategies ?? 1,

      rolling_window_size:
        config.consensus?.rollingWindowSize ?? 30,

      gate: {
        min_win_rate:
          config.consensus?.gate?.minWinRate ?? 0.48,

        min_sharpe_ratio:
          config.consensus?.gate?.minSharpeRatio ?? 0.80,

        min_rolling_expectancy:
          config.consensus?.gate?.minRollingExpectancy ?? 0.00,

        max_drawdown:
          config.consensus?.gate?.maxDrawdown ?? 0.22,

        min_trades_for_gate:
          config.consensus?.gate?.minTradesForGate ?? 20,
      },
    };

    this.consensus = new ConsensusOrchestrator(
      db,
      consensusCfg,
    );

    this.risk = new RiskManager(
      config,
      db,
      this.telegram,
      this.emergency,
    );

    this.adaptiveTuner = new AdaptiveTuner(
      db,
      this.consensus.registry as any,
      config,
    );

    this.mtf = new MultiTimeframeConfirm(this.scanner);
    this.stale = new StaleDataGuard();

    this.weekendGuard = new WeekendGuard(
      config,
      db,
      this.exec,
      this.telegram,
    );

    this.weeklyReport = new WeeklyReport(
      db,
      this.telegram,
    );

    this.smartExit = new SmartExitManager(
      config,
      db,
      this.scanner,
      this.exec,
    );

    this.reconciler = new Reconciler(
      config,
      db,
      this.exec,
      this.telegram,
      this.tracker,
      this.scanner,
      this.emergency,

      async (trade) => {
        if (trade.source) {
          this.consensus.recordClose(
            trade.source,
            trade.profit ?? 0,
            trade.entry,
            (trade as any).exitPrice ?? trade.entry,
          );
        }

        this.risk.recordClose(trade.profit ?? 0);
        this.posTracker.recordClose(trade.symbol);

        await this.tradeJournal
          .record(trade as any)
          .catch(() => {});

        this.broadcast('trade_closed', trade);
        this.events.emit('trade:closed', trade);
      },
    );

    this.multiTP = new MultiLevelPartialTP(
      config,
      db,
      this.exec,
      this.scanner,
    );

    this.trailing = new TrailingStop(
      config,
      db,
      this.scanner,
      this.exec,
    );

    this.scaleIn = new ScaleInManager(
      config,
      db,
      this.exec,
      this.scanner,
    );

    this.timeExit = new TimeBasedExit(
      config,
      db,
      this.exec,
      this.scanner,
      this.telegram,
    );

    this.breakeven = new BreakevenManager(
      config,
      db,
      this.scanner,
    );

    this.dbBackup = new DbBackup(
      db.path,
      config.s3Backup?.enabled
        ? {
            endpoint: config.s3Backup.endpoint,
            bucket: config.s3Backup.bucket,
            accessKey: config.s3Backup.accessKey,
            secretKey: config.s3Backup.secretKey,
            region: config.s3Backup.region,
          }
        : undefined,
      config.s3Backup?.encryptionKey,
    );
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  setBroadcaster(b: Broadcaster) {
    this.broadcast = b;
  }

  get emergencyStop() {
    return this.emergency;
  }

  async start() {
    if (this.isRunning) return;

    this.ready = false;

    this.logger.info(
      'Starting TradingEngine v9.0...',
    );

    await this.exec.initialize();

    this.validSymbols = await this.validator.validate();

    if (this.validSymbols.length === 0) {
      throw new Error(
        '[Startup] No valid market symbols available; refusing to mark the trading engine ready',
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

    await this.telegram
      .sendMessage(
        `🚀 <b>Trading Bot v9.0</b>\n` +
          `Mode: ${this.config.mode.toUpperCase()} | Symbols: ${this.validSymbols.length}\n` +
          `🧠 Strategies: ${csStatus.active_count} active | 📊 Positions: ${this.posTracker.count()}\n` +
          `✨ v9: Candlestick + D1 Bias + TimeFilter + SmartExit + MultiTP`,
      )
      .catch(() => {});

    this.broadcast('engine', {
      running: true,
    });

    this.cycle().catch((e) =>
      this.logger.error(
        `cycle: ${e?.message ?? String(e)}`,
      ),
    );

    this.timer = setInterval(
      () =>
        this.cycle().catch((e) =>
          this.logger.error(
            `cycle: ${e?.message ?? String(e)}`,
          ),
        ),
      this.config.scanInterval,
    );

    this.heartbeatTimer = setInterval(
      () => this.logHeartbeat(),
      5 * 60_000,
    );

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

    await this.telegram
      .sendMessage('🛑 Trading bot v9.0 stopped')
      .catch(() => {});

    this.broadcast('engine', {
      running: false,
    });
  }

  isActive() {
    return this.isRunning;
  }

  isReady() {
    return (
      this.isRunning &&
      this.ready &&
      this.validSymbols.length > 0
    );
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
      if (
        !this.isRunning ||
        this.emergency.isActive()
      ) {
        return;
      }

      await this.risk.refreshNews().catch(() => {});
      await this.sentiment.refreshData().catch(() => {});

      const symbols = this.validSymbols.length
        ? this.validSymbols
        : this.config.symbols;

      for (
        let i = 0;
        i < symbols.length;
        i += MAX_CONCURRENT_SYMBOLS
      ) {
        if (
          !this.isRunning ||
          this.emergency.isActive()
        ) {
          return;
        }

        const batch = symbols.slice(
          i,
          i + MAX_CONCURRENT_SYMBOLS,
        );

        await Promise.allSettled(
          batch.map((symbol) =>
            this.processSymbolAllTF(symbol).catch((e) =>
              this.logger.error(
                `[${symbol}] batch error: ${e?.message ?? String(e)}`,
              ),
            ),
          ),
        );
      }
    } finally {
      this.lastCycleAt = Date.now();
      this.lastCycleDurationMs =
        Date.now() - cycleStartedAt;
    }
  }

  private async processSymbolAllTF(symbol: string) {
    await this.raceSafety.withLock(
      symbol,
      async () => {
        let d1Ready = false;

        try {
          const d1 = await this.scanner.fetchCandles(
            symbol,
            'D1',
            250,
          );

          if (d1.length >= 200) {
            this.d1Cache[symbol] = d1;
            d1Ready = true;
          }
        } catch (e: any) {
          this.logger.warn(
            `[${symbol}] D1 data unavailable; symbol blocked fail-closed: ${
              e?.message ?? e
            }`,
          );
        }

        if (!d1Ready) {
          this.logger.info(
            `[PIPELINE_BLOCK] ${symbol} stage=D1_DATA`,
          );
          return;
        }

        for (const tf of this.config.timeframes) {
          if (
            !this.isRunning ||
            this.emergency.isActive()
          ) {
            return;
          }

          if (this.posTracker.hasOpenPosition(symbol)) {
            this.logger.info(
              `[PIPELINE_BLOCK] ${symbol}/${tf} stage=OPEN_POSITION`,
            );
            return;
          }

          try {
            await this.processSymbol(symbol, tf);
          } catch (e: any) {
            this.logger.error(
              `[${symbol}] ${tf}: ${e?.message ?? String(e)}`,
            );
          }
        }
      },
      60_000,
    );
  }

  private async processSymbol(
    symbol: string,
    tf: Timeframe,
  ) {
    const rateLimitKey = `${symbol}_${tf}`;

    if (
      Date.now() -
        (this.lastTradeAt[rateLimitKey] ?? 0) <
      5 * 60_000
    ) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=RATE_LIMIT`,
      );
      return;
    }

    // ── Time-based filter ──────────────────────────────────────────────
    if (this.timeFilter.shouldBlock()) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=TIME_FILTER`,
      );
      return;
    }

    const timeScore =
      this.timeFilter.getMultiplier();

    // ── Drawdown recovery ──────────────────────────────────────────────
    const equity =
      await this.exec.getCurrentEquity();

    if (
      !(
        equity != null &&
        equity > 0 &&
        Number.isFinite(equity)
      )
    ) {
      this.logger.error(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=EQUITY ` +
          `reason=current_equity_unavailable`,
      );
      return;
    }

    const recoveryState =
      this.recoveryMode.evaluate(equity);

    if (recoveryState.level === 'STOP') {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=RECOVERY_STOP`,
      );
      return;
    }

    // ── Current timeframe candles ──────────────────────────────────────
    const candles =
      await this.scanner.fetchCandles(
        symbol,
        tf,
        250,
      );

    if (candles.length < 220) {
      this.logger.warn(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=CANDLES ` +
          `count=${candles.length} required=220`,
      );
      return;
    }

    this.candleMap[symbol] = candles;

    // ── Data quality ───────────────────────────────────────────────────
    const dataQuality =
      this.dataQuality.validate(candles, tf);

    if (!dataQuality.ok) {
      this.logger.warn(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=DATA_QUALITY ` +
          `reason=${dataQuality.reasons.slice(0, 5).join(', ')}`,
      );
      return;
    }

    // ── Freshness ──────────────────────────────────────────────────────
    const fresh =
      this.stale.isFresh(candles, tf);

    if (!fresh.ok) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=STALE_DATA`,
      );
      return;
    }

    // ── Market regime ─────────────────────────────────────────────────
    const regime =
      marketRegimeDetector.detect(
        symbol,
        tf,
        candles,
      );

    if (regime.regime === 'VOLATILE') {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=VOLATILE`,
      );
      return;
    }

    if (tf === 'H4') {
      this.h4Cache[symbol] = candles;
    }

    const h4Candles =
      this.h4Cache[symbol] ?? [];

    const d1Candles =
      this.d1Cache[symbol] ?? [];

    // ── Adaptive ATR ───────────────────────────────────────────────────
    this.adaptiveATR.getParams(
      symbol,
      candles,
    );

    // ── Consensus ──────────────────────────────────────────────────────
    const consensus =
      this.consensus.process(
        symbol,
        candles,
        h4Candles,
        regime.regime,
      );

    this.consensusDecisionCount += 1;

    this.broadcast('consensus', {
      symbol,
      tf,
      outcome: consensus.outcome,
      block_reason:
        consensus.block_reason,
    });

    if (
      consensus.outcome === 'NO_TRADE' ||
      !consensus.signal
    ) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=CONSENSUS ` +
          `reason=${consensus.block_reason}`,
      );
      return;
    }

    this.signalCandidateCount += 1;

    let signal: Signal =
      consensus.signal;

    this.logger.info(
      `[PIPELINE_SIGNAL] ${symbol}/${tf} ` +
        `side=${signal.side} ` +
        `confidence=${signal.confidence.toFixed(3)} ` +
        `source=${signal.source}`,
    );

    this.db.insertSignal(signal);

    if (
      !this.consensus.isKnownStrategySource(
        signal.source,
      )
    ) {
      this.logger.error(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=SOURCE ` +
          `source=${signal.source}`,
      );
      return;
    }

    // ── D1 Trend Bias ──────────────────────────────────────────────────
    const d1bias =
      this.d1Bias.evaluate(
        symbol,
        signal.side,
        signal.source,
        d1Candles,
      );

    if (!d1bias.allows) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=D1_BIAS ` +
          `reason=${d1bias.reason}`,
      );
      return;
    }

    signal = {
      ...signal,
      confidence: Math.min(
        0.95,
        signal.confidence *
          d1bias.confidMult,
      ),
    };

    // ── MTF confirmation ───────────────────────────────────────────────
    const mtfResult =
      tf === 'H4'
        ? {
            approved: true,
            h1ok: true,
            h4ok: true,
          }
        : await this.mtf.confirmFull(
            symbol,
            signal.side,
          );

    if (!mtfResult.approved) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=MTF ` +
          `side=${signal.side} ` +
          `h1ok=${mtfResult.h1ok} ` +
          `h4ok=${mtfResult.h4ok} ` +
          `reason=${mtfResult.reason ?? 'unknown'}`,
      );
      return;
    }

    this.logger.info(
      `[PIPELINE_PASS] ${symbol}/${tf} stage=MTF ` +
        `side=${signal.side}`,
    );

    // ── Candlestick pattern ────────────────────────────────────────────
    const pattern =
      this.candlePatterns.analyze(
        candles,
        signal.side,
      );

    if (
      pattern.conflictsBias &&
      pattern.strength === 'STRONG'
    ) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=CANDLE_PATTERN ` +
          `pattern=${pattern.name}`,
      );
      return;
    }

    if (pattern.found) {
      signal = {
        ...signal,
        confidence: Math.min(
          0.95,
          signal.confidence +
            pattern.boost,
        ),
      };
    }

    // ── Sentiment ──────────────────────────────────────────────────────
    const sent =
      await this.sentiment
        .getSentiment(symbol)
        .catch(() => null);

    if (
      sent?.bias &&
      sent.impact === 'STRONG'
    ) {
      if (
        sent.bias !== signal.side &&
        sent.bias !== 'NONE'
      ) {
        this.logger.info(
          `[PIPELINE_BLOCK] ${symbol}/${tf} stage=SENTIMENT ` +
            `bias=${sent.bias} ` +
            `side=${signal.side} ` +
            `reason=${sent.reason}`,
        );
        return;
      }

      if (sent.bias === signal.side) {
        signal = {
          ...signal,
          confidence: Math.min(
            0.95,
            signal.confidence +
              0.03,
          ),
        };
      }
    }

    // ── ML Enhancement ─────────────────────────────────────────────────
    const mlSignal =
      await this.mlEnhancer.enhance(
        signal,
        candles,
        h4Candles,
        tf,
      );

    let aiMul = 1.0;

    try {
      aiMul =
        await this.nvidiaAI.scoreSignal(
          mlSignal,
        );
    } catch (e: any) {
      if (
        this.config.mode !== 'paper' ||
        this.config.mlRequired
      ) {
        this.logger.warn(
          `[PIPELINE_BLOCK] ${symbol}/${tf} stage=NVIDIA_AI ` +
            `reason=${e?.message ?? String(e)}`,
        );
        return;
      }

      this.logger.warn(
        `[PIPELINE_PASS] ${symbol}/${tf} stage=NVIDIA_AI ` +
          `mode=paper fallback=true reason=${
            e?.message ?? String(e)
          }`,
      );
    }

    const finalSignal: Signal = {
      ...mlSignal,
      confidence: Math.min(
        0.95,
        mlSignal.confidence *
          aiMul,
      ),
    };

    // ── Quality gate ───────────────────────────────────────────────────
    const sourceWR =
      this.getSourceWinRate(
        finalSignal.source,
      );

    const quality =
      this.qualityScorer.score(
        finalSignal,
        candles,
        regime.regime,
        sourceWR,
      );

    if (quality.grade === 'F') {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=QUALITY ` +
          `grade=${quality.grade} ` +
          `total=${quality.total} ` +
          `reasons=${quality.reasons
            .slice(0, 6)
            .join(' | ')}`,
      );
      return;
    }

    this.logger.info(
      `[PIPELINE_PASS] ${symbol}/${tf} stage=QUALITY ` +
        `grade=${quality.grade} ` +
        `total=${quality.total}`,
    );

    // ── Spread adjustment / ticker ─────────────────────────────────────
    const ticker =
      await this.fetchTicker(symbol);

    if (!ticker) {
      this.logger.warn(
        `[PIPELINE_TICKER] ${symbol}/${tf} ` +
          `ticker_unavailable`,
      );
    }

    let adjustedSignal =
      finalSignal;

    if (ticker) {
      const spread =
        ticker.ask - ticker.bid;

      adjustedSignal =
        this.spreadAdj.adjust(
          adjustedSignal,
          spread,
        );
    }

    // ── Recovery strategy filter ───────────────────────────────────────
    if (recoveryState.allowedStrategies) {
      const allowed =
        this.recoveryMode.isStrategyAllowed(
          adjustedSignal.source,
          recoveryState,
        );

      if (!allowed) {
        this.logger.info(
          `[PIPELINE_BLOCK] ${symbol}/${tf} stage=RECOVERY ` +
            `level=${recoveryState.level} ` +
            `source=${adjustedSignal.source}`,
        );
        return;
      }
    }

    // ── Risk pipeline ──────────────────────────────────────────────────
    const openTrades =
      this.db.getOpenTrades();

    const livePrices = ticker
      ? {
          [symbol]:
            (ticker.bid + ticker.ask) / 2,
        }
      : {};

    const risk =
      await this.risk.check(
        adjustedSignal,
        openTrades,
        ticker ?? undefined,
        equity,
        quality.total,
        livePrices,
        this.candleMap,
      );

    if (!risk.passed) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=RISK ` +
          `reason=${risk.blockedBy} ` +
          `detail=${
            risk.reasons?.[0] ?? 'unknown'
          }`,
      );
      return;
    }

    this.logger.info(
      `[PIPELINE_PASS] ${symbol}/${tf} stage=RISK ` +
        `volume=${risk.volume}`,
    );

    // ── Apply time & recovery volume multipliers ───────────────────────
    const spec =
      getSymbolSpec(symbol);

    const rawVolume =
      risk.volume *
      timeScore.multiplier *
      recoveryState.volumeMultiplier;

    const stepped =
      Math.floor(
        rawVolume /
          spec.volumeStep +
          1e-12,
      ) * spec.volumeStep;

    const adjustedVolume =
      Math.min(
        spec.maxVolume,
        Math.max(
          0,
          Number(
            stepped.toFixed(8),
          ),
        ),
      );

    // ── Re-apply absolute risk cap ─────────────────────────────────────
    const volume =
      this.risk
        .getSizer()
        .capToAbsoluteRisk(
          symbol,
          adjustedSignal.price,
          adjustedSignal.sl,
          adjustedVolume,
          equity,
        );

    if (!(volume > 0)) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=VOLUME ` +
          `riskVolume=${risk.volume} ` +
          `adjustedVolume=${adjustedVolume} ` +
          `finalVolume=${volume}`,
      );
      return;
    }

    // ── Final duplicate position check ─────────────────────────────────
    if (
      this.posTracker.hasOpenPosition(
        symbol,
      )
    ) {
      this.logger.info(
        `[PIPELINE_BLOCK] ${symbol}/${tf} stage=OPEN_POSITION_FINAL`,
      );
      return;
    }

    // ── Execute ────────────────────────────────────────────────────────
    this.logger.info(
      `[PIPELINE_EXECUTE] ${symbol}/${tf} ` +
        `side=${adjustedSignal.side} ` +
        `volume=${volume} ` +
        `confidence=${adjustedSignal.confidence.toFixed(3)}`,
    );

    let result:
      Awaited<
        ReturnType<
          ExecutionGateway['execute']
        >
      >;

    try {
      result =
        await this.exec.execute(
          adjustedSignal,
          volume,
          tf,
        );
    } catch (e: any) {
      this.logger.error(
        `[PIPELINE_BLOCK] ${symbol}/${tf} ` +
          `stage=EXECUTION ` +
          `error=${e?.message ?? String(e)}`,
      );
      return;
    }

    // ── Execution failed ───────────────────────────────────────────────
    if (!result.success) {
      this.logger.error(
        `[PIPELINE_BLOCK] ${symbol}/${tf} ` +
          `stage=EXECUTION ` +
          `error=${result.error ?? 'unknown'}`,
      );
      return;
    }

    // ── Execution says success but no Trade returned ───────────────────
    if (!result.trade) {
      this.logger.error(
        `[PIPELINE_BLOCK] ${symbol}/${tf} ` +
          `stage=EXECUTION ` +
          `error=success_without_trade`,
      );
      return;
    }

    // ── Execution successful ───────────────────────────────────────────
    this.logger.info(
      `[PIPELINE_SUCCESS] ${symbol}/${tf} ` +
        `ticket=${result.trade.ticket ?? 'unknown'} ` +
        `entry=${result.trade.entry} ` +
        `volume=${result.trade.volume}`,
    );

    this.lastTradeAt[rateLimitKey] =
      Date.now();

    this.posTracker.recordOpen(
      symbol,
      adjustedSignal.side,
      tf,
      adjustedSignal.source,
    );

    // Count only successful paper executions.
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

    await this.telegram
      .sendMessage(
        `✅ <b>${result.trade.side} ${result.trade.symbol}</b> [${tf}]\n` +
          `Vol: ${volume} @ ${result.trade.entry}\n` +
          `SL: ${result.trade.sl.toFixed(5)} | TP: ${result.trade.tp.toFixed(5)}\n` +
          `📊 Regime: ${regime.regime} | Q: ${quality.total}/100 (${quality.grade})\n` +
          `🧠 ${consensus.votes.length} voters | dom=${consensus.dominance_ratio.toFixed(2)}\n` +
          `🕯 ${patternStr}${d1str} | 🕐 ×${timeScore.multiplier} | 🛡 ${recoveryState.level}`,
      )
      .catch(() => {});

    this.events.emit(
      'trade:opened',
      result.trade,
    );

    this.broadcast(
      'trade_open',
      result.trade,
    );
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────────

  private logHeartbeat() {
    const lastCycle =
      this.lastCycleAt > 0
        ? new Date(
            this.lastCycleAt,
          ).toISOString()
        : 'never';

    const symbols =
      this.validSymbols.length > 0
        ? this.validSymbols.join(',')
        : 'none';

    let openPositions = 0;

    try {
      openPositions =
        this.posTracker.count();
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
        `lastCycleMs=${this.lastCycleDurationMs}`,
    );
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async fetchTicker(
    symbol: string,
  ): Promise<{
    bid: number;
    ask: number;
  } | null> {
    try {
      const useMt5 =
        this.config.mode === 'mt5' ||
        (
          this.config.mode === 'paper' &&
          this.config.dataSource === 'mt5'
        );

      if (useMt5) {
        const r =
          await axios.get(
            `${this.config.mt5.bridgeUrl}/tick`,
            {
              params: { symbol },
              timeout: 3000,
              headers:
                this.config.mt5.bridgeApiKey
                  ? {
                      'X-Api-Key':
                        this.config.mt5.bridgeApiKey,
                    }
                  : {},
            },
          );

        const bid =
          Number(r.data.bid);

        const ask =
          Number(r.data.ask);

        if (
          !Number.isFinite(bid) ||
          !Number.isFinite(ask) ||
          !(ask > bid)
        ) {
          throw new Error(
            `Invalid MT5 ticker bid=${r.data.bid} ask=${r.data.ask}`,
          );
        }

        return {
          bid,
          ask,
        };
      }

      const base =
        this.config.binance.futures
          ? (
              this.config.binance.env ===
              'testnet'
                ? 'https://testnet.binancefuture.com/fapi/v1/ticker/bookTicker'
                : 'https://fapi.binance.com/fapi/v1/ticker/bookTicker'
            )
          : (
              this.config.binance.env ===
              'testnet'
                ? 'https://testnet.binance.vision/api/v3/ticker/bookTicker'
                : 'https://api.binance.com/api/v3/ticker/bookTicker'
            );

      const r =
        await axios.get(
          base,
          {
            params: {
              symbol,
            },
            timeout: 3000,
          },
        );

      const bid =
        Number(r.data.bidPrice);

      const ask =
        Number(r.data.askPrice);

      if (
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        !(ask > bid)
      ) {
        throw new Error(
          `Invalid Binance ticker bid=${r.data.bidPrice} ask=${r.data.askPrice}`,
        );
      }

      return {
        bid,
        ask,
      };
    } catch (e: any) {
      this.logger.warn(
        `[PIPELINE_TICKER] ${symbol} fetch failed: ${
          e?.message ?? String(e)
        }`,
      );

      return null;
    }
  }

  private getSourceWinRate(
    source: string,
  ): number {
    try {
      const primary =
        source.split('+')[0];

      const cutoff =
        Date.now() -
        30 *
          24 *
          3_600_000;

      const row =
        this.db
          .raw()
          .prepare(
            `SELECT COUNT(*) total,
                    SUM(
                      CASE
                        WHEN profit > 0
                        THEN 1
                        ELSE 0
                      END
                    ) wins
             FROM trades
             WHERE status='closed'
               AND source LIKE ?
               AND openedAt > ?`,
          )
          .get(
            `%${primary}%`,
            cutoff,
          ) as
          | {
              total: number;
              wins: number;
            }
          | undefined;

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

  getRuntimeMetrics() {
    return {
      running: this.isRunning,
      ready: this.isReady(),
      mode: this.config.mode,
      symbols: [...this.validSymbols],

      cycleCount:
        this.cycleCount,

      consensusDecisionCount:
        this.consensusDecisionCount,

      signalCandidateCount:
        this.signalCandidateCount,

      paperTradeCount:
        this.paperTradeCount,

      lastCycleAt:
        this.lastCycleAt > 0
          ? new Date(
              this.lastCycleAt,
            ).toISOString()
          : null,

      lastCycleDurationMs:
        this.lastCycleDurationMs,

      openPositions: (() => {
        try {
          return this.posTracker.count();
        } catch {
          return 0;
        }
      })(),
    };
  }

  async triggerEmergencyStop(
    reason: string,
  ) {
    await this.emergency.activate(
      reason,
    );
  }

  async resumeTrading(
    approver: string,
  ) {
    await this.emergency.deactivate(
      approver,
    );
  }
}