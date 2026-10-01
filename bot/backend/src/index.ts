/**
 * ENTRY POINT — v9.1 PROFESSIONAL FINAL
 * v9.1 FIX: no duplicate modules, clean wiring only
 */
import 'dotenv/config';
import * as http                      from 'http';
import { Server as IOServer }         from 'socket.io';
import { TradingEngine }              from './core/TradingEngine';
import { DatabaseManager }            from './database/DatabaseManager';
import { HealthMonitor }              from './integration/HealthMonitor';
import { GracefulShutdown }           from './integration/GracefulShutdown';
import { StartupReconciler }          from './integration/StartupReconciler';
import { createApi }                  from './api/server';
import { Logger }                     from './utils/Logger';
import { loadConfig }                 from './utils/loadConfig';
import { WalkForwardOptimizer }       from './optimization/WalkForwardOptimizer';
import { MonteCarloSimulator }        from './optimization/MonteCarloSimulator';
import { ScheduledWFO }               from './optimization/ScheduledWFO';
import { MLTrainingPipeline }         from './ml/MLTrainingPipeline';
import { AutoSymbolDiscovery }        from './core/AutoSymbolDiscovery';
import { TelegramCommands }           from './notifications/TelegramCommands';
import { CorrelationMatrixBuilder }   from './portfolio/CorrelationMatrix';
import { BinanceWebSocketFeed }       from './execution/BinanceWebSocketFeed';

const log    = new Logger('Main');
const config = loadConfig();

async function main() {
  log.info(`${'='.repeat(60)}`);
  log.info(`Trading Bot v9.1 | Mode: ${config.mode.toUpperCase()}`);
  log.info(`Symbols: ${config.symbols.join(', ')}`);
  log.info(`Balance: $${config.accountBalance.toLocaleString()}`);
  log.info('='.repeat(60));

  const db = new DatabaseManager(config.dbPath);
  await db.initialize();
  log.info('Database ready');

  const engine = new TradingEngine(config, db);

  // Replace TelegramBot with queued version BEFORE start()
  const telegram = engine.telegram;

  // Startup reconciliation — sync DB with broker
  log.info('Running startup reconciliation...');
  const reconciler = new StartupReconciler(config, db, telegram);
  await reconciler.run();

  // External modules not created by TradingEngine
  const mlPipeline = new MLTrainingPipeline(db);
  const discovery  = new AutoSymbolDiscovery(engine['scanner'] as any, db);
  const wfo        = new WalkForwardOptimizer(config.dbPath, config.accountCurrency ?? 'USD');
  const mc         = new MonteCarloSimulator();
  const corrMatrix = new CorrelationMatrixBuilder();

  (engine as any).mlPipeline  = mlPipeline;
  (engine as any).discovery   = discovery;
  (engine as any).wfo         = wfo;
  (engine as any).mc          = mc;
  (engine as any).corrMatrix  = corrMatrix;
  (engine as any).db          = db;

  if (process.env.AUTO_SYMBOLS === 'true') {
    const symbols = await discovery.getBestSymbols(config.mode);
    if (symbols.length > 0) { engine.validSymbols = symbols; }
  }

  const autoTrainAllowed = process.env.ML_AUTO_TRAIN_ENABLED === 'true'
    && (config.mode === 'paper' || process.env.LIVE_ML_TRAIN_ACK === 'I_UNDERSTAND_LIVE_ML_TRAIN');
  if (autoTrainAllowed && mlPipeline.needsTraining()) {
    mlPipeline.train().then(r => {
      if (r.ok) log.info(`ML trained: ${r.samples} samples | ${(r.accuracy*100).toFixed(1)}% accuracy`);
    }).catch(e => log.error(`Initial ML training failed: ${e?.message ?? e}`));
  }
  if (autoTrainAllowed) {
    setInterval(() => {
      if (mlPipeline.needsTraining()) mlPipeline.train().catch(e => log.error(`Scheduled ML training failed: ${e?.message ?? e}`));
    }, 6 * 3_600_000);
  }

  const tgCommands = new TelegramCommands(config, engine);
  (engine as any).tgCommands = tgCommands;

  // Binance WebSocket feed (Binance mode only)
  let wsFeed: BinanceWebSocketFeed | null = null;
  if (config.mode === 'binance' && config.symbols?.length) {
    const tfs = (config.timeframes as string[]) ?? ['H1', 'H4'];
    wsFeed = new BinanceWebSocketFeed(config.symbols, tfs);
    wsFeed.on('candle', ({ symbol, tf, candle, closed }) => {
      if (closed) {
        const map = (engine as any).candleMap ?? {};
        if (!map[symbol]) map[symbol] = [];
        map[symbol].push(candle);
        if (map[symbol].length > 500) map[symbol].shift();
        (engine as any).candleMap = map;
      }
    });
    wsFeed.on('error', (e) => log.warn(`WS error: ${e}`));
    await wsFeed.connect();
    log.info('WebSocket connected — waiting 15s for buffer...');
    await new Promise(r => setTimeout(r, 15_000));
  }

  const health    = new HealthMonitor(config, db, telegram, engine.emergencyStop);
  health.start();

  const app    = createApi(engine);
  const server = http.createServer(app);
  const io     = new IOServer(server, {
    cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:3000', credentials: true },
  });
  engine.setBroadcaster((event, data) => io.emit(event, data));

  // Render.com يعطي رقم المنفذ عبر PORT، وليس API_PORT
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
  await new Promise<void>(r => server.listen(port, r));
  log.info(`API listening on port ${port}`);

  await engine.start();

  // Start automatic WFO only after the execution engine is fully ready.
  const scheduledWFO = new ScheduledWFO(
    config,
    db,
    engine['scanner'] as any,
    telegram,
    () => engine.isActive(),
  );
  scheduledWFO.start();
  (engine as any).scheduledWFO = scheduledWFO;

  GracefulShutdown.register(
    {
      stop: async () => { health.stop(); scheduledWFO.stop(); wsFeed?.disconnect(); await engine.stop(); await new Promise<void>(resolve => server.close(() => resolve())); },
      isActive: () => engine.isActive(),
    },
    telegram,
    db,
  );

  log.info('='.repeat(60));
  log.info('Bot running and accepting requests');
  log.info('='.repeat(60));
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
