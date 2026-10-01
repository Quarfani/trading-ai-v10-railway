/**
 * WALK-FORWARD OPTIMIZATION RUNNER
 * Usage: ts-node src/optimization/runWFO.ts EURUSD H1 2000
 */
import 'dotenv/config';
import { MarketScanner } from '../core/MarketScanner';
import { DatabaseManager }      from '../database/DatabaseManager';
import { WalkForwardOptimizer } from './WalkForwardOptimizer';
import { MonteCarloSimulator }  from './MonteCarloSimulator';
import { Logger }               from '../utils/Logger';

const log = new Logger('RunWFO');

async function main() {
  const symbol    = (process.argv[2] ?? 'EURUSD').toUpperCase();
  const timeframe = (process.argv[3] ?? 'H1').toUpperCase();
  const count     = Number(process.argv[4] ?? 2000);

  log.info(`Walk-Forward Optimization: ${symbol} ${timeframe} (${count} candles)`);

  const db  = new DatabaseManager(process.env.DB_PATH ?? './data/trading.db');
  await db.initialize();

  // Fetch candles via MarketScanner (import dynamically to avoid full engine init)
  const config = { mode: (process.env.MODE ?? 'paper') as any,
    mt5: { bridgeUrl: process.env.MT5_BRIDGE_URL ?? 'http://localhost:5000' },
    binance: { apiKey: '', secret: '', env: 'testnet' as const },
  } as any;

  const scanner = new MarketScanner(config);
  const candles = await scanner.fetchCandles(symbol, timeframe as any, count);
  log.info(`Fetched ${candles.length} candles`);

  // Run Walk-Forward
  const wfo    = new WalkForwardOptimizer(db.path);
  const result = await wfo.run(symbol, candles, timeframe as any);

  console.log('\n══════════════════════════════════════════════');
  console.log(`WALK-FORWARD RESULTS: ${symbol} ${timeframe}`);
  console.log('══════════════════════════════════════════════');
  console.log(`Windows:        ${result.windows.length}`);
  console.log(`OOS Win Rate:   ${(result.oos_winRate * 100).toFixed(1)}%`);
  console.log(`OOS Sharpe:     ${result.oos_sharpe.toFixed(2)}`);
  console.log(`OOS Total P/L:  ${result.oos_profit.toFixed(2)}%`);
  console.log(`Recommendation: ${result.recommendation}`);
  console.log(`Valid:          ${result.valid}`);
  console.log(`Evidence folds: ${result.evidence.folds}`);
  console.log(`OOS trades:     ${result.evidence.oosTrades}`);
  console.log(`Reason:         ${result.reason}`);
  console.log('\nOptimized Params:');
  console.log(`  atrMult:       ${result.finalParams.atrMult}`);
  console.log(`  tpRatio:       ${result.finalParams.tpRatio}`);
  console.log(`  minConfidence: ${result.finalParams.minConfidence}`);
  console.log('');

  // Save params if recommended
  if (result.valid && result.recommendation === 'TRADE') {
    wfo.saveParams(db, symbol, result.finalParams, timeframe as any);
    console.log('✅ Params saved to DB — will be used on next bot startup');
  }

  // Run Monte Carlo on closed trades
  const trades = db.raw().prepare(
    `SELECT profit FROM trades WHERE status='closed' AND symbol=? AND profit IS NOT NULL`
  ).all(symbol) as Array<{ profit: number }>;

  if (trades.length >= 10) {
    console.log('\nRunning Monte Carlo...');
    const mc     = new MonteCarloSimulator();
    const mcRes  = mc.run(trades, 10_000, 5_000, 100);
    console.log(mc.summarize(mcRes));
  } else {
    console.log('\nMonte Carlo: insufficient trade history (< 10 trades)');
  }

  // Window summary
  console.log('\nWindow Details:');
  console.log('Window | Train WR | Test WR  | Test Sharpe | Valid | Best atrMult');
  console.log('-------+---------+---------+-------------+-------+-------------');
  for (let i = 0; i < result.windows.length; i++) {
    const w = result.windows[i];
    console.log(
      `  ${String(i + 1).padEnd(4)}` +
      ` | ${(w.trainMetrics.winRate*100).toFixed(1).padStart(7)}%` +
      ` | ${(w.testMetrics.winRate*100).toFixed(1).padStart(7)}%` +
      ` | ${w.testMetrics.sharpe.toFixed(2).padStart(11)}` +
      ` | ${w.oos_valid ? '  ✅  ' : '  ❌  '}` +
      ` | ${w.bestParams.atrMult}`
    );
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
