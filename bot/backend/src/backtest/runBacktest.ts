/**
 * CLI Backtest Runner
 * Usage: npx ts-node --transpile-only src/backtest/runBacktest.ts EURUSD M15 2000
 */
import 'dotenv/config';
import { loadConfig }    from '../utils/loadConfig';
import { MarketScanner } from '../core/MarketScanner';
import { Backtester }    from './Backtester';
import { isTimeframe, Timeframe } from '../market/market.types';

async function main() {
  const symbol = process.argv[2] ?? 'EURUSD';
  const rawTf = (process.argv[3] ?? 'M15').trim().toUpperCase();
  if (!isTimeframe(rawTf)) {
    console.error(`Invalid timeframe "${rawTf}". Valid: M1, M5, M15, M30, H1, H4, D1`);
    process.exit(1);
  }
  const tf: Timeframe = rawTf;
  const count = Number(process.argv[4] ?? 2000);
  if (!Number.isInteger(count) || count < 300 || count > 10000) {
    console.error('Count must be an integer between 300 and 10000');
    process.exit(1);
  }

  const config  = loadConfig();
  const scanner = new MarketScanner(config);

  console.log(`Fetching ${count} ${tf} candles for ${symbol}...`);
  const candles = await scanner.fetchCandles(symbol, tf, count);
  if (candles.length < 300) { console.error('Not enough candles'); process.exit(1); }

  const r = await new Backtester(config).run(symbol, candles, config.accountBalance, tf);

  console.log('\n══════════════════════════════════════════════');
  console.log(`  Backtest: ${symbol} | ${tf} | ${candles.length} bars`);
  console.log('══════════════════════════════════════════════');
  console.log(`Trades:          ${r.totalTrades} (${r.wins}W / ${r.losses}L)`);
  console.log(`Win Rate:        ${r.winRate.toFixed(1)}%`);
  console.log(`Profit Factor:   ${r.profitFactor.toFixed(2)}`);
  console.log(`Expectancy:      $${r.expectancy.toFixed(2)}/trade`);
  console.log(`Risk:Reward:     1:${r.riskReward.toFixed(2)}`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`Total Return:    ${r.totalReturn.toFixed(2)}%`);
  console.log(`Max Drawdown:    ${r.maxDrawdownPct.toFixed(2)}%  ($${r.maxDrawdownUsd.toFixed(2)})`);
  console.log(`Sharpe Ratio:    ${r.sharpeRatio.toFixed(2)}`);
  console.log(`Sortino Ratio:   ${r.sortinoRatio.toFixed(2)}`);
  console.log(`Calmar Ratio:    ${r.calmarRatio.toFixed(2)}`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`Max Win Streak:  ${r.maxConsecWins}`);
  console.log(`Max Loss Streak: ${r.maxConsecLosses}`);
  console.log(`Commission:      $${r.totalCommission.toFixed(2)}`);
  console.log(`Spread Cost:     $${r.totalSpread.toFixed(2)}`);
  console.log('══════════════════════════════════════════════');

  if (r.monthlyBreakdown.length) {
    console.log('\n  Monthly P&L:');
    for (const m of r.monthlyBreakdown) {
      const bar = m.pnl >= 0 ? '▓'.repeat(Math.min(20, Math.floor(m.pnl / 10))) : '░'.repeat(Math.min(20, Math.floor(-m.pnl / 10)));
      console.log(`  ${m.month}  ${m.pnl >= 0 ? '+' : ''}$${m.pnl.toFixed(0).padStart(7)} ${bar}`);
    }
  }
  console.log('');
}

main().catch(e => { console.error(e); process.exit(1); });
