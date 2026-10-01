/**
 * SCHEDULED WFO — new module
 * ════════════════════════════════════════════════════════════════════
 * WHY THIS IS NEEDED:
 *   WalkForwardOptimizer exists and works correctly.
 *   It is only run manually via runWFO.ts CLI.
 *   Strategy parameters (atrMult, tpRatio, minConfidence) never
 *   auto-update in production — they drift from optimal as market
 *   conditions evolve (regime changes, volatility shifts, etc).
 *
 * WHAT THIS DOES:
 *   - Runs WFO on the 1st of each month at 03:00 UTC
 *   - Applies the resulting optimal params to the live system
 *   - Sends a full WFO report to Telegram
 *   - Saves results to DB for audit trail
 *
 * HOW TO USE (in index.ts after engine.start()):
 *   const scheduler = new ScheduledWFO(config, db, engine, telegram);
 *   scheduler.start();
 *   // on shutdown:
 *   scheduler.stop();
 * ════════════════════════════════════════════════════════════════════
 */
import { SystemConfig }         from '../types/trading.types';
import { DatabaseManager }      from '../database/DatabaseManager';
import { WalkForwardOptimizer } from '../optimization/WalkForwardOptimizer';
import { Backtester }           from '../backtest/Backtester';
import { TelegramBot }          from '../notifications/TelegramBot';
import { MarketScanner }        from '../core/MarketScanner';
import { getBrokerMarketDefinition, getMarketDefinition }  from '../market/MarketCatalog';
import { loadHistoricalCurrencySeries } from '../market/HistoricalCurrencySeriesLoader';
import { Logger } from '../utils/Logger';
import { EvidenceSnapshotStore } from '../analytics/EvidenceSnapshotStore';
import { evaluateEvidenceForPromotion } from '../consensus/EvidencePromotionPolicy';
import { COST_MODEL_VERSION, CostProfile } from '../market/CostModel';
import { getCostProfile } from '../market/CostProfiles';

const WFO_HOUR_UTC   = 3;   // run at 03:00 UTC
const WFO_DAY_OF_MONTH = 1; // run on the 1st of each month
const CHECK_INTERVAL = 10 * 60_000; // check every 10 minutes

export class ScheduledWFO {
  private logger   = new Logger('ScheduledWFO');
  private interval: NodeJS.Timeout | null = null;
  private lastRunMonth = '';
  private running  = false;

  private wfo: WalkForwardOptimizer;
  private readonly evidenceSnapshots: EvidenceSnapshotStore;

  constructor(
    private config:   SystemConfig,
    private db:       DatabaseManager,
    private scanner:  MarketScanner,
    private telegram: TelegramBot,
  ) {
    this.wfo = new WalkForwardOptimizer(db.path);
    this.evidenceSnapshots = new EvidenceSnapshotStore(db);
  }

  start(): void {
    if (!this.isAllowedToMutateParams()) {
      this.logger.warn('Scheduled WFO disabled: automatic parameter mutation is restricted to paper mode by default');
      return;
    }
    if (this.interval) return;
    this.interval = setInterval(() => this.tick().catch(() => {}), CHECK_INTERVAL);
    this.logger.info(`Scheduled WFO: will run on day ${WFO_DAY_OF_MONTH} at ${WFO_HOUR_UTC}:00 UTC`);
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  /** Force an immediate WFO run (callable from TelegramCommands /wfo) */
  async runNow(symbol?: string): Promise<void> {
    if (!this.isAllowedToMutateParams()) throw new Error('Live WFO is disabled; explicit LIVE_WFO_ACK is required outside paper mode');
    await this.runWFO(symbol ? [symbol] : this.config.symbols);
  }

  private isAllowedToMutateParams(): boolean {
    if (this.config.mode === 'paper') return process.env.AUTO_WFO_ENABLED === 'true';
    return process.env.AUTO_WFO_ENABLED === 'true' && process.env.LIVE_WFO_ACK === 'I_UNDERSTAND_LIVE_WFO_RISK';
  }

  private async loadHistoricalRates(
    symbol: string,
    count: number,
    market?: ReturnType<typeof getMarketDefinition>,
  ) {
    const effectiveMarket = market ?? (
      this.config.mode === 'mt5' || this.config.dataSource === 'mt5'
        ? getBrokerMarketDefinition(symbol)
        : getMarketDefinition(symbol)
    );
    if (!effectiveMarket) return {};

    return loadHistoricalCurrencySeries(
      effectiveMarket.quoteCurrency,
      (this.config.accountCurrency ?? 'USD').toUpperCase(),
      async (pair, requestedCount) => {
        return this.scanner.fetchCandles(pair, 'D1', requestedCount);
      },
      count,
    );
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (this.running) return;

    const now        = new Date();
    const month      = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
    const isWFOTime  = now.getUTCDate() === WFO_DAY_OF_MONTH
                    && now.getUTCHours() === WFO_HOUR_UTC;

    if (!isWFOTime || this.lastRunMonth === month) return;

    this.lastRunMonth = month;
    await this.runWFO(this.config.symbols);
  }

  private async runWFO(symbols: string[]): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.logger.info(`Monthly WFO starting for ${symbols.length} symbols...`);
    await this.telegram
      .sendMessage(`🔄 <b>Monthly WFO Started</b>\nOptimizing ${symbols.length} symbols...`)
      .catch(() => {});

    const results: string[] = [];
    let successCount = 0;

    const timeframes = (this.config.timeframes ?? ['H1']).filter(Boolean);

    for (const symbol of symbols) {
      for (const timeframe of timeframes) {
        try {
          const candles = await this.scanner
            .fetchCandles(symbol, timeframe, 2000)
            .catch(() => []);

          if (candles.length < 500) {
            this.logger.warn(
              `WFO skip ${symbol}/${timeframe}: only ${candles.length} candles`,
            );
            continue;
          }

          const brokerBacked =
            this.config.mode === 'mt5' ||
            this.config.dataSource === 'mt5';

          const market = brokerBacked
            ? getBrokerMarketDefinition(symbol, timeframe)
            : getMarketDefinition(symbol, timeframe);

          if (!market) {
            throw new Error(
              `No canonical market definition for ${symbol}/${timeframe}`,
            );
          }

          let costProfile: CostProfile;
          try {
            costProfile = getCostProfile(symbol, {
              priceIncrement: market.economics.priceIncrement,
              requireExplicit: brokerBacked && Boolean(market.brokerSymbol),
            });
          } catch (error) {
            throw new Error(
              `Cost profile unavailable for ${symbol}/${timeframe}: ` +
              `\${error instanceof Error ? error.message : String(error)}`,
            );
          }

          const historicalRates = await this.loadHistoricalRates(
            symbol,
            candles.length,
            market,
          );

          const result = await this.wfo.run(
            symbol,
            candles,
            timeframe,
            historicalRates,
            market,
            costProfile,
          );

          const p = result.finalParams;

          const policy = this.config.evidencePromotion;
          const promotionEvidence = evaluateEvidenceForPromotion(
            {
              datasetVersion:
                'WFO-' + symbol + '-' + timeframe + '-' + String(result.runAt),
              costModelVersion: COST_MODEL_VERSION,
              sampleSize: candles.length,
              outOfSampleTrades: result.evidence.oosTrades,
              outOfSampleProfitFactor: result.evidence.weightedProfitFactor,
              walkForwardStability: result.evidence.walkForwardStability,
              parameterSensitivity: 0,
              regimeCoverage: 0,
              passed: result.valid && result.evidence.passed,
              evaluatedAt: result.runAt,
            },
            policy,
          );

          const scopeKey = symbol + '_' + timeframe + '_WFO';
          const promoted =
            result.recommendation === 'TRADE' &&
            promotionEvidence.passed;

          try {
            this.db.raw().prepare(
              "INSERT INTO system_events(event,severity,payload,timestamp) VALUES (?,?,?,?)",
            ).run(
              promoted ? 'WFO_PROMOTED' : 'WFO_REJECTED',
              promoted ? 'INFO' : 'WARN',
              JSON.stringify({
                symbol,
                timeframe,
                recommendation: result.recommendation,
                resultValid: result.valid,
                policyPassed: promotionEvidence.passed,
                policyReasons: promotionEvidence.reasons,
                evidence: result.evidence,
              }),
              Date.now(),
            );
          } catch {
            // Audit persistence must never make WFO itself fail.
          }

          this.evidenceSnapshots.save({
            scopeKey,
            symbol,
            timeframe,
            source: 'WFO',
            evidence: {
              ...result.evidence,
              monteCarloStress: result.monteCarloStress,
              promotionPolicy: {
                passed: promotionEvidence.passed,
                reasons: promotionEvidence.reasons,
              },
            },
            promoted,
            promotionReason: promoted
              ? 'valid WFO evidence and shared promotion policy passed'
              : promotionEvidence.reasons.join('; ') || result.reason,
          });

          results.push(
            `${symbol}/${timeframe}: ATR×${p.atrMult.toFixed(2)} TP×${p.tpRatio.toFixed(2)} ` +
            `conf=${p.minConfidence.toFixed(2)} OOS_WR=${(result.oos_winRate * 100).toFixed(1)}%`,
          );

          if (result.valid && result.recommendation === 'TRADE' && promotionEvidence.passed) {
            this.db.setSetting(
              `wfo_params_${symbol}_${timeframe}`,
              JSON.stringify({
                ...p,
                updatedAt: Date.now(),
                timeframe,
                wfoValid: true,
              }),
            );
            successCount++;
            this.logger.info(
              `WFO ${symbol}/${timeframe}: params promoted after valid OOS evaluation`,
            );
          } else {
            this.logger.warn(
              `WFO ${symbol}/${timeframe}: params NOT promoted valid=${result.valid} recommendation=${result.recommendation} reason=${result.reason}`,
            );
          }

        } catch (e: any) {
          this.logger.error(`WFO failed for ${symbol}/${timeframe}: ${e.message}`);
          results.push(`${symbol}/${timeframe}: ❌ ${e.message}`);
        }
      }
    }

    const report =
      `✅ <b>Monthly WFO Complete</b>\n` +
      `${successCount}/${symbols.length * timeframes.length} symbol/timeframe runs promoted\n\n` +
      `<b>New params:</b>\n` +
      results.map(r => `  ${r}`).join('\n');

    await this.telegram.sendMessage(report).catch(() => {});
    this.logger.info(`WFO complete: ${successCount}/${symbols.length * timeframes.length} symbol/timeframe runs promoted`);
    this.running = false;
  }
}
