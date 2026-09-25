/**
 * DOWNLOAD HISTORY + PRETRAIN + WALK-FORWARD
 * ══════════════════════════════════════════════════════════════════════════
 * أمر شامل يقوم بـ:
 *   1. تحميل سنة أو سنتين من البيانات التاريخية
 *   2. تشغيل Backtest على كل رمز
 *   3. Walk-Forward Optimization (معاملات مُحسَّنة)
 *   4. Monte Carlo Simulation (تقييم المخاطر)
 *   5. تدريب نموذج ML على الصفقات التاريخية المُولَّدة
 *   6. حفظ كل شيء في DB الجاهزة للتداول الفوري
 *
 * الاستخدام:
 *   npm run download-history
 *   npm run download-history -- --years 2 --tf H1 --symbols EURUSD,GBPUSD,XAUUSD
 *   npm run download-history -- --years 1 --tf H4 --skip-wfo
 * ══════════════════════════════════════════════════════════════════════════
 */
import 'dotenv/config';
import * as path from 'path';
import * as fs   from 'fs';
import { HistoricalDataDownloader } from './HistoricalDataDownloader';
import { Backtester }               from './Backtester';
import { WalkForwardOptimizer }     from '../optimization/WalkForwardOptimizer';
import { MonteCarloSimulator }      from '../optimization/MonteCarloSimulator';
import { DatabaseManager }          from '../database/DatabaseManager';
import { loadConfig }               from '../utils/loadConfig';
import { Candle }                   from '../types/trading.types';

// ─── Parse CLI args ───────────────────────────────────────────────────────

function parseArgs() {
  const args: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args[k] = v ?? process.argv[i + 1] ?? '';
      if (!v) i++; // consumed next arg
    }
  }
  return {
    years:   Number(args.years   ?? 2),
    tf:      args.tf             ?? 'H1',
    symbols: (args.symbols ?? 'EURUSD,GBPUSD,USDJPY,XAUUSD,AUDUSD,USDCAD,BTCUSDT,ETHUSDT')
               .split(',').map(s => s.trim().toUpperCase()),
    skipWfo:  args['skip-wfo']  !== undefined,
    skipMc:   args['skip-mc']   !== undefined,
    dbPath:   args.db           ?? './data/trading.db',
    outDir:   args.out          ?? './data',
  };
}

// ─── Helper: convert CSV bars → Candle[] ─────────────────────────────────

function toCandleArray(bars: Array<{time:number;open:number;high:number;low:number;close:number;volume:number}>): Candle[] {
  return bars.map(b => ({
    time: b.time, open: b.open, high: b.high,
    low: b.low, close: b.close, volume: b.volume,
  }));
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log('\n' + '═'.repeat(65));
  console.log('  TRADING BOT v9.0 — HISTORICAL DATA & PRETRAINING PIPELINE');
  console.log('═'.repeat(65));
  console.log(`  Years:    ${opts.years}`);
  console.log(`  TF:       ${opts.tf}`);
  console.log(`  Symbols:  ${opts.symbols.join(', ')}`);
  console.log(`  DB:       ${opts.dbPath}`);
  console.log(`  Skip WFO: ${opts.skipWfo}`);
  console.log('═'.repeat(65) + '\n');

  const config   = loadConfig();
  const db       = new DatabaseManager(opts.dbPath);
  await db.initialize();

  const downloader = new HistoricalDataDownloader(opts.outDir);
  const mc         = new MonteCarloSimulator();
  const wfo        = new WalkForwardOptimizer(opts.dbPath);
  const bt         = new Backtester(config);

  const report: Array<{
    symbol: string; bars: number; wfRecommendation: string;
    backtest: { winRate: number; sharpe: number; maxDD: number; totalReturn: number };
    mcRuin: number; mcp50: number; safeRisk: number;
    paramsApplied: boolean;
  }> = [];

  // ── STEP 1: Download historical data ────────────────────────────────────
  console.log('STEP 1/4 — Downloading Historical Data\n' + '─'.repeat(40));
  const dlResults = await downloader.download(opts.symbols, opts.tf, opts.years);

  const successful = dlResults.filter(r => r.ok);
  if (!successful.length) {
    console.error('\n❌ No data downloaded. Check your internet connection.');
    process.exit(1);
  }
  console.log(`\n✅ Downloaded ${successful.length}/${dlResults.length} symbols\n`);

  // ── STEP 2: Backtest each symbol ─────────────────────────────────────────
  console.log('STEP 2/4 — Running Backtests\n' + '─'.repeat(40));

  for (const dl of successful) {
    const rawBars = downloader.loadBars(dl.symbol, dl.timeframe);
    if (rawBars.length < 500) {
      console.log(`  ⚠️  ${dl.symbol}: only ${rawBars.length} bars — skipping backtest`);
      continue;
    }

    const candles = toCandleArray(rawBars);
    console.log(`  ⏳ Backtesting ${dl.symbol} (${candles.length.toLocaleString()} bars)...`);

    try {
      const btResult = await bt.run(dl.symbol, candles, config.accountBalance);
      console.log(
        `  ✅ ${dl.symbol}: WR=${(btResult.winRate*100).toFixed(1)}% ` +
        `Sharpe=${btResult.sharpeRatio.toFixed(2)} ` +
        `MaxDD=${btResult.maxDrawdownPct.toFixed(1)}% ` +
        `Return=${btResult.totalReturn.toFixed(1)}%`
      );

      // ── Monte Carlo on backtest trades ──────────────────────────────
      let mcRuin = 0, mcP50 = config.accountBalance, safeRisk = 0.01;
      if (!opts.skipMc && btResult.trades.length >= 20) {
        const mcResult = mc.run(
          btResult.trades.map(t => ({ profit: t.pnl })),
          config.accountBalance, 5000, 100
        );
        mcRuin    = mcResult.probRuin;
        mcP50     = mcResult.p50;
        safeRisk  = mcResult.safePositionPct;
        console.log(
          `  📊 MC: P(ruin)=${(mcRuin*100).toFixed(1)}% ` +
          `Median=$${mcP50.toFixed(0)} ` +
          `SafeRisk=${(safeRisk*100).toFixed(2)}%`
        );
      }

      report.push({
        symbol: dl.symbol, bars: candles.length,
        wfRecommendation: 'PENDING',
        backtest: {
          winRate:     btResult.winRate,
          sharpe:      btResult.sharpeRatio,
          maxDD:       btResult.maxDrawdownPct,
          totalReturn: btResult.totalReturn,
        },
        mcRuin, mcp50: mcP50, safeRisk, paramsApplied: false,
      });
    } catch (e: any) {
      console.log(`  ❌ ${dl.symbol} backtest failed: ${e.message}`);
    }
  }

  // ── STEP 3: Walk-Forward Optimization ───────────────────────────────────
  if (!opts.skipWfo) {
    console.log('\nSTEP 3/4 — Walk-Forward Optimization\n' + '─'.repeat(40));

    for (const entry of report) {
      const rawBars = downloader.loadBars(entry.symbol, opts.tf);
      if (rawBars.length < 1000) {
        console.log(`  ⚠️  ${entry.symbol}: need 1000+ bars for WFO (have ${rawBars.length})`);
        continue;
      }

      const candles = toCandleArray(rawBars);
      console.log(`  ⏳ WFO ${entry.symbol} (${candles.length.toLocaleString()} bars)...`);

      try {
        const wfoResult = await wfo.run(entry.symbol, candles);
        entry.wfRecommendation = wfoResult.recommendation;

        console.log(
          `  ${wfoResult.recommendation === 'TRADE' ? '✅' : wfoResult.recommendation === 'CAUTION' ? '⚠️' : '❌'} ` +
          `${entry.symbol}: ${wfoResult.recommendation} | ` +
          `OOS WR=${(wfoResult.oos_winRate*100).toFixed(1)}% ` +
          `Sharpe=${wfoResult.oos_sharpe.toFixed(2)}`
        );

        // Save optimized params if recommended
        if (wfoResult.recommendation !== 'DO_NOT_TRADE') {
          wfo.saveParams(db, entry.symbol, wfoResult.finalParams);
          entry.paramsApplied = true;
          console.log(
            `     📌 Params saved: atrMult=${wfoResult.finalParams.atrMult} ` +
            `tpRatio=${wfoResult.finalParams.tpRatio} ` +
            `minConf=${wfoResult.finalParams.minConfidence}`
          );
        }
      } catch (e: any) {
        console.log(`  ❌ ${entry.symbol} WFO failed: ${e.message}`);
      }
    }
  } else {
    console.log('\nSTEP 3/4 — Walk-Forward SKIPPED (--skip-wfo)\n');
    report.forEach(r => r.wfRecommendation = 'SKIPPED');
  }

  // ── STEP 4: Inject historical trades into DB for ML training ─────────────
  console.log('\nSTEP 4/4 — Seeding DB for ML Pre-Training\n' + '─'.repeat(40));

  let totalInjected = 0;
  for (const entry of report) {
    const rawBars = downloader.loadBars(entry.symbol, opts.tf);
    if (rawBars.length < 300) continue;

    const candles  = toCandleArray(rawBars);
    let injected   = 0;
    try {
      const btResult = await bt.run(entry.symbol, candles, config.accountBalance);
      const insert   = db.raw().prepare(`
        INSERT OR IGNORE INTO trades
          (symbol, timeframe, side, volume, entry, sl, tp, status, openedAt, closedAt, profit, source, exitReason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const insertAll = db.raw().transaction(() => {
        for (const t of btResult.trades) {
          insert.run(
            entry.symbol, opts.tf, t.side,
            t.size, t.entry, t.sl, t.tp,
            'closed', t.openedAt, t.closedAt,
            t.pnl, t.source, t.exitReason,
          );
          injected++;
        }
      });
      insertAll();
      totalInjected += injected;
      console.log(`  ✅ ${entry.symbol}: ${injected} historical trades injected`);
    } catch (e: any) {
      console.log(`  ❌ ${entry.symbol} seed failed: ${e.message}`);
    }
  }

  console.log(`\n  Total injected: ${totalInjected.toLocaleString()} trades\n`);

  // ── FINAL REPORT ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(65));
  console.log('  FINAL REPORT');
  console.log('═'.repeat(65));
  console.log(
    '  Symbol      Bars       WR      Sharpe  MaxDD   WFO         MC Ruin'
  );
  console.log('  ' + '─'.repeat(62));

  for (const e of report) {
    const wfEmoji = e.wfRecommendation === 'TRADE'       ? '✅' :
                   e.wfRecommendation === 'CAUTION'      ? '⚠️' :
                   e.wfRecommendation === 'DO_NOT_TRADE' ? '❌' : '⏭';
    console.log(
      `  ${e.symbol.padEnd(10)}` +
      ` ${e.bars.toLocaleString().padStart(8)}` +
      ` ${(e.backtest.winRate*100).toFixed(1).padStart(7)}%` +
      ` ${e.backtest.sharpe.toFixed(2).padStart(8)}` +
      `  ${e.backtest.maxDD.toFixed(1).padStart(5)}%` +
      `  ${wfEmoji} ${e.wfRecommendation.padEnd(12)}` +
      ` ${(e.mcRuin*100).toFixed(1)}%`
    );
  }

  console.log('\n  Safe symbols (TRADE recommendation):');
  const safe = report.filter(r => r.wfRecommendation === 'TRADE');
  if (safe.length) {
    console.log(`  SYMBOLS=${safe.map(r => r.symbol).join(',')}`);
    console.log('\n  ✅ Add this to your .env file!');
  } else {
    console.log('  ⚠️  No symbols got TRADE recommendation yet.');
    console.log('  → Try --years 1 or check data quality');
  }

  // Save report to JSON
  const reportPath = path.join(opts.outDir, 'pretraining_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), opts, report }, null, 2));
  console.log(`\n  📄 Full report saved: ${reportPath}`);

  console.log('\n' + '═'.repeat(65));
  console.log('  NEXT STEPS:');
  console.log('  1. npm run dev     ← Start the bot (ML will train on injected data)');
  console.log('  2. Monitor paper trading for 1-2 weeks');
  console.log('  3. Check /api/ml/status for model accuracy');
  console.log('═'.repeat(65) + '\n');

  process.exit(0);
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
