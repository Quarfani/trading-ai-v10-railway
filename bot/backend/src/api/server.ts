/**
 * REST API — v7.1
 * [FIX] getRecentAudits() كانت تُستدعى على TradingEngine لكنها موجودة في DB
 * [NEW] /api/consensus  — حالة الاستراتيجيات الثماني + أوزانها الحالية
 * [NEW] /api/positions  — الصفقات المفتوحة من PositionTracker
 * [NEW] /api/regime/:symbol — نظام السوق الحالي
 * [NEW] /api/backtest   — يدعم async backtesting
 */
import express, { Express, Request, Response, NextFunction } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import cors    from 'cors';
import { z }   from 'zod';
import { TradingEngine }       from '../core/TradingEngine';
import { Logger }              from '../utils/Logger';
import { authMiddleware, login, requireRole } from './auth';
import { rateLimit }           from './rateLimit';
import { exportTradesCSV, getEquityCurve } from '../analytics/CsvExporter';
import { Backtester }          from '../backtest/Backtester';
import { marketRegimeDetector } from '../core/MarketRegimeDetector';
import { getBrokerContractStatus } from '../market/MarketCatalog';

const ALLOWED_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:3000';

const LoginSchema    = z.object({ password: z.string().min(1) });
const BacktestSchema = z.object({
  symbol:    z.string().min(3).max(20).regex(/^[A-Z0-9]+$/),
  timeframe: z.enum(['M1','M5','M15','M30','H1','H4','D1']),
  count:     z.number().int().min(300).max(5000).optional(),
});
const NoteSchema      = z.object({ note: z.string().max(500) });
const EmergencySchema = z.object({ reason: z.string().max(200).optional() });
const ResumeSchema    = z.object({ approver: z.string().max(100).optional() });

function validate<T>(schema: z.ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: 'Validation failed', details: result.error.issues });
    req.body = result.data;
    next();
  };
}

export function createApi(engine: TradingEngine) {
  const app = express();
  const log  = new Logger('API');

  app.use(cors({
    origin: ALLOWED_ORIGIN, credentials: true,
    methods: ['GET','POST','OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json({ limit: '512kb' }));
  app.use(rateLimit(180));
  app.use(authMiddleware);

  // ── Root / smoke test ────────────────────────────────────────────────
  app.get('/', (_: Request, res: Response) =>
    res.json({ service: 'trading-bot-backend', ok: true, health: '/api/health' })
  );

  // ── Auth ──────────────────────────────────────────────────────────────
  app.post('/api/auth/login', validate(LoginSchema), login);

  // ── Health (public) ───────────────────────────────────────────────────
  const healthPayload = () => ({ ok: true, running: engine.isActive(), mode: engine.config.mode, ts: Date.now(), version: '9.2' });
  app.get('/api/health', (_: Request, res: Response) => res.json(healthPayload()));
  app.get('/health', (_: Request, res: Response) => res.json(healthPayload()));
  app.get('/liveness', (_: Request, res: Response) => res.json(healthPayload()));
  app.get('/ready', (_: Request, res: Response) => {
    const status = engine.readiness();
    if (!status.ready) return res.status(503).json({ ok: false, ...status, reason: 'engine_not_ready', ts: Date.now() });
    return res.json({ ok: true, ...status, ts: Date.now() });
  });

  // ── Status ────────────────────────────────────────────────────────────
  app.get('/api/status', (_: Request, res: Response) =>
    res.json({
      running:        engine.isActive(),
      mode:           engine.config.mode,
      circuitBreaker: engine.getRiskStatus(),
      performance:    engine.getPerformanceSummary(),
      openPositions:  engine.getPositionSummary(),        // [NEW]
      raceSafety:     engine.getRaceSafetyStats(),        // [NEW]
    })
  );

  // ── [NEW] Consensus / Strategy status ─────────────────────────────────
  app.get('/api/consensus', (_: Request, res: Response) =>
    res.json(engine.getConsensusStatus())
  );

  app.get('/api/consensus/log', (req: Request, res: Response) => {
    const n = Math.min(200, Math.max(1, Number(req.query.n ?? 50)));
    res.json({ log: engine.getConsensusLog(n) });
  });

  // ── [NEW] Positions ───────────────────────────────────────────────────
  app.get('/api/positions', (_: Request, res: Response) =>
    res.json({ positions: engine.getPositionSummary() })
  );

  // ── Trades ────────────────────────────────────────────────────────────
  app.get('/api/trades', (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50)));
    res.json({ trades: engine['db'].getRecentTrades(limit) });
  });

  // â”€â”€ Railway -> Windows backup bridge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Creates a consistent SQLite snapshot without exposing the live DB path.
  app.get('/api/backup/sqlite', requireRole('admin'), (_req: Request, res: Response) => {
    const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-ai-db-'));
    const snapshotName = `trading-db-${Date.now()}.sqlite`;
    const snapshotPath = path.join(tmpDir, snapshotName);
    const cleanup = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };

    try {
      const db = engine['db']?.raw?.();
      if (!db) {
        cleanup();
        return res.status(503).json({ error: 'Database is not ready' });
      }

      // VACUUM INTO creates a consistent SQLite snapshot while the live DB remains online.
      const escapedPath = snapshotPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escapedPath}'`);

      const size = fs.statSync(snapshotPath).size;
      if (!Number.isFinite(size) || size <= 0) {
        cleanup();
        return res.status(500).json({ error: 'Backup snapshot is empty' });
      }
      if (size > MAX_BACKUP_BYTES) {
        cleanup();
        return res.status(413).json({ error: 'Backup snapshot exceeds 256 MB safety limit' });
      }

      res.setHeader('Content-Type', 'application/x-sqlite3');
      res.setHeader('Content-Length', String(size));
      res.setHeader('Content-Disposition', `attachment; filename="${snapshotName}"`);
      res.setHeader('X-Backup-Method', 'sqlite-vacuum-into');
      res.setHeader('X-Backup-Size', String(size));
      res.on('finish', cleanup);
      res.on('close', cleanup);

      return res.sendFile(snapshotPath, (err) => {
        if (err) log.error(`[BackupAPI] SQLite download failed: ${err.message}`);
        cleanup();
      });
    } catch (e: any) {
      cleanup();
      log.error(`[BackupAPI] Snapshot failed: ${e?.message ?? String(e)}`);
      return res.status(500).json({ error: 'Database backup failed' });
    }
  });
  app.get('/api/trades/open', (_: Request, res: Response) =>
    res.json({ trades: engine['db'].getOpenTrades() })
  );

  app.get('/api/trades.csv', (_: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=trades.csv');
    res.send(exportTradesCSV(engine['db']));
  });

  app.post('/api/trades/:id/note', validate(NoteSchema), (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid ID' });
    engine['db'].setNote(id, req.body.note);
    res.json({ ok: true });
  });

  // ── Analytics ─────────────────────────────────────────────────────────
  app.get('/api/equity', (_: Request, res: Response) =>
    res.json({ curve: getEquityCurve(engine['db'], engine.config.accountBalance) })
  );

  app.get('/api/signals', (req: Request, res: Response) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50)));
    res.json({ signals: engine['db'].getRecentSignals(limit) });
  });

  // [FIX] getRecentAudits is on DB, not engine
  app.get('/api/decisions', (req: Request, res: Response) => {
    const hours = Math.min(48, Math.max(0.1, Number(req.query.hours ?? 1)));
    res.json({ decisions: engine['db'].getRecentAudits(hours) });
  });

  // ── Paper stats ───────────────────────────────────────────────────────
  app.get('/api/paper/stats', (_: Request, res: Response) => {
    const stats = engine['exec'].getPaperStats();
    if (!stats) return res.status(400).json({ error: 'Not in paper mode' });
    res.json(stats);
  });

  // ── [NEW] Market Regime ───────────────────────────────────────────────
  app.get('/api/regime/:symbol', (req: Request, res: Response) => {
    const symbolParam = req.params.symbol;
    const sym = (Array.isArray(symbolParam) ? symbolParam[0] : symbolParam).toUpperCase();
    const tf  = (req.query.tf as string ?? 'H1').toUpperCase();
    const candleMap = engine['candleMap'] as Record<string, any[]>;
    const candles   = candleMap?.[sym];
    if (!candles || candles.length < 50) {
      return res.json({ regime: 'UNKNOWN', reason: 'No cached candles' });
    }
    const result = marketRegimeDetector.detect(sym, tf, candles);
    res.json(result);
  });

  // ── Engine control ────────────────────────────────────────────────────
  app.post('/api/control/start', requireRole('admin', 'operator'), async (_: Request, res: Response) => {
    if (!engine.isActive()) await engine.start();
    res.json({ ok: true });
  });

  app.post('/api/control/stop', requireRole('admin', 'operator'), async (_: Request, res: Response) => {
    await engine.stop();
    res.json({ ok: true });
  });

  app.post('/api/control/emergency', requireRole('admin', 'operator'), validate(EmergencySchema), async (req: Request, res: Response) => {
    await engine.triggerEmergencyStop(req.body.reason ?? 'Manual');
    res.json({ ok: true });
  });

  app.post('/api/control/resume', requireRole('admin'), validate(ResumeSchema), async (req: Request, res: Response) => {
    await engine.resumeTrading(req.body.approver ?? 'API');
    res.json({ ok: true });
  });

  // ── [FIX+NEW] Backtest (async) ────────────────────────────────────────
  app.post('/api/backtest', validate(BacktestSchema), async (req: Request, res: Response) => {
    try {
      const { symbol, timeframe, count = 1000 } = req.body;
      const candles = await engine['scanner'].fetchCandles(symbol, timeframe, count);
      if (!candles || candles.length < 300) {
        return res.status(400).json({ error: 'Insufficient candle data' });
      }
      const bt = new Backtester(engine.config);
      const result = await bt.run(symbol, candles, engine.config.accountBalance);
      res.json(result);
    } catch (e: any) {
      log.error(`Backtest error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Symbols ───────────────────────────────────────────────────────────
  app.get('/api/symbols', (_: Request, res: Response) =>
    res.json({ symbols: engine.validSymbols })
  );

  app.get('/api/contracts', (_: Request, res: Response) =>
    res.json(
      engine.config.mode === 'mt5'
        ? getBrokerContractStatus(engine.validSymbols)
        : { ready: true, count: 0, contracts: [] },
    )
  );

  extendApiV8(app, engine);
  extendApiV9(app, engine);
  return app;
}

// ── v8.0 Additional endpoints (appended) ──────────────────────────────────────
// These are added at module bottom; createApi() must be called on the same app

export function extendApiV8(app: Express, engine: any) {
  // MEGA archive / disaster-recovery status (non-secret).
  // MEGA credentials stay on the dedicated Windows backup agent.
  app.get('/api/storage/status', (_req: any, res: any) => {
    const truthy = new Set(['1', 'true', 'yes', 'on']);
    const megaEnabled = truthy.has(String(process.env.MEGA_BACKUP_ENABLED ?? '').toLowerCase());
    const credentialsPresent = Boolean(process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD);

    res.json({
      mega: {
        enabled: megaEnabled,
        credentialsPresent,
        mode: megaEnabled ? 'runtime' : 'external-windows-agent',
        folder: process.env.MEGA_FOLDER ?? '/TradingAI/backups',
        note: 'MEGA is an archive/DR target; live trading state stays in the runtime database.',
      },
    });
  });

  // Monte Carlo
  app.post('/api/montecarlo', async (req: any, res: any) => {
    try {
      const trades = engine['db'].getRecentClosedTrades(200)
        .filter((t: any) => t.profit !== undefined);
      const mc     = engine['mc'];
      if (!mc) return res.status(503).json({ error: 'MC not ready' });
      const result = mc.run(trades, engine.config.accountBalance,
        Number(req.body.simulations ?? 10_000), Number(req.body.trades ?? 100));
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Walk-Forward (async, returns cached result or triggers new run)
  app.post('/api/walkforward', requireRole('admin'), async (req: any, res: any) => {
    try {
      // WFO temporarily sets strategy parameters in process.env. Never allow
      // that research mutation while the live/paper execution loop is active.
      if (engine.isActive()) {
        return res.status(409).json({
          error: 'Stop the trading engine before running walk-forward optimization',
        });
      }

      const { symbol = 'EURUSD', timeframe = 'H1', count = 1500 } = req.body;
      if (engine.config.mode !== 'paper' && process.env.LIVE_WFO_ACK !== 'I_UNDERSTAND_LIVE_WFO_RISK') {
        return res.status(403).json({ error: 'Live parameter mutation requires explicit LIVE_WFO_ACK' });
      }
      const candles = await engine['scanner'].fetchCandles(symbol, timeframe, count);
      const wfo     = engine['wfo'];
      if (!wfo) return res.status(503).json({ error: 'WFO not ready' });
      const result = await wfo.run(symbol, candles);
      if (result.recommendation === 'TRADE') wfo.saveParams(engine['db'], symbol, result.finalParams);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Sentiment
  app.get('/api/sentiment/:symbol', async (req: any, res: any) => {
    try {
      const s = engine['sentiment'];
      if (!s) return res.status(503).json({ error: 'Sentiment not ready' });
      const symbolParam = req.params.symbol;
      const sym = (Array.isArray(symbolParam) ? symbolParam[0] : symbolParam).toUpperCase();
      res.json(await s.getSentiment(sym));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Correlation matrix
  app.get('/api/correlation', (req: any, res: any) => {
    try {
      const cm      = engine['corrMatrix'];
      const candleMap = engine['candleMap'] ?? {};
      const symbols   = engine.validSymbols ?? [];
      const matrix    = cm?.build(candleMap, symbols, 50);
      res.json(matrix ?? { symbols: [], matrix: [], highPairs: [] });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Adaptive ATR params
  app.get('/api/adaptive-atr', (req: any, res: any) => {
    res.json(engine['adaptiveATR']?.getSummary() ?? {});
  });

  // Recovery status
  app.get('/api/recovery', async (req: any, res: any) => {
    try {
      const equity = await engine['exec'].getCurrentEquity();
      res.json(engine['recoveryMode']?.evaluate(equity) ?? { level: 'GREEN' });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Trade journal
  app.get('/api/journal', (req: any, res: any) => {
    const limit = Math.min(100, Number(req.query.limit ?? 50));
    res.json({ entries: engine['tradeJournal']?.getEntries(limit) ?? [] });
  });

  app.get('/api/journal/grades', (req: any, res: any) => {
    res.json(engine['tradeJournal']?.getGradeDistribution() ?? {});
  });

  // Symbol discovery results
  app.get('/api/symbols/scores', (req: any, res: any) => {
    res.json({ scores: engine['discovery']?.getLastResults() ?? [] });
  });

  // ML model status & feature importance
  app.get('/api/ml/status', (req: any, res: any) => {
    const ml = engine['mlPipeline'];
    res.json({
      trained:    ml ? !ml.needsTraining() : false,
      importance: ml?.getFeatureImportance() ?? {},
    });
  });

  app.post('/api/ml/train', requireRole('admin'), async (req: any, res: any) => {
    const ml = engine['mlPipeline'];
    if (!ml) return res.status(503).json({ error: 'ML not ready' });
    const r = await ml.train();
    res.json(r);
  });
}

// ── v9.0 Additional endpoints ──────────────────────────────────────────────────
export function extendApiV9(app: Express, engine: any) {
  // Time Heatmap
  app.get('/api/heatmap', (_req: any, res: any) => {
    const h = engine['timeFilter']?.getHeatmap();
    res.json(h ?? { hourlyWinRate: new Array(24).fill(0.5), hourlyTrades: new Array(24).fill(0), message: 'No data yet' });
  });

  // D1 Bias for a symbol
  app.get('/api/d1bias/:symbol', (req: any, res: any) => {
    const symbolParam = req.params.symbol;
    const sym = (Array.isArray(symbolParam) ? symbolParam[0] : symbolParam).toUpperCase();
    const d1  = engine['d1Cache']?.[sym] ?? [];
    if (!d1.length) { res.json({ trend: 'NEUTRAL', reason: 'No D1 data cached yet' }); return; }
    const result = engine['d1Bias']?.evaluate(sym, 'BUY', 'TREND', d1);
    res.json(result ?? { trend: 'NEUTRAL' });
  });

  // Candlestick pattern for current candle
  app.get('/api/pattern/:symbol', (req: any, res: any) => {
    const symbolParam = req.params.symbol;
    const sym = (Array.isArray(symbolParam) ? symbolParam[0] : symbolParam).toUpperCase();
    const candles = engine['candleMap']?.[sym];
    if (!candles?.length) { res.json({ found: false }); return; }
    const pattern = engine['candlePatterns']?.analyze(candles, 'BUY');
    res.json(pattern ?? { found: false });
  });

  // Smart exit decisions on open trades
  app.get('/api/smart-exit/status', (_req: any, res: any) => {
    const open = engine['db']?.getOpenTrades() ?? [];
    res.json({ openTrades: open.length, smartExitActive: !!engine['smartExit'] });
  });

  // v9 full status
  app.get('/api/v9/status', async (_req: any, res: any) => {
    try {
      const equity   = await engine['exec']?.getCurrentEquity() ?? 0;
      const recovery = engine['recoveryMode']?.evaluate(equity);
      const time     = engine['timeFilter']?.getMultiplier();
      res.json({
        recovery:  recovery ?? null,
        timeScore: time     ?? null,
        d1Cache:   Object.keys(engine['d1Cache'] ?? {}).length,
        adaptiveATR: engine['adaptiveATR']?.getSummary() ?? {},
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
}
