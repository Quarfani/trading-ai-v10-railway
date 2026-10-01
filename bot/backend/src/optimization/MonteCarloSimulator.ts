/**
 * MONTE CARLO SIMULATOR — v8.0
 * ══════════════════════════════════════════════════════════════════════════
 * يُحاكي 10,000 مسار عشوائي لنتائج الصفقات بناءً على التوزيع الإحصائي
 * الفعلي للأرباح والخسائر التاريخية.
 *
 * يُجيب على:
 *   1. ما احتمالية الربح بعد N صفقة؟
 *   2. ما أسوأ Drawdown ممكن بثقة 95%؟
 *   3. ما الحجم الأقصى الآمن بناءً على هذا الـ Drawdown؟
 *   4. هل الاستراتيجية مربحة إحصائياً أم محظوظة فقط؟
 *
 * المنهجية:
 *   Bootstrap Resampling: يسحب بشكل عشوائي من نتائج الصفقات الفعلية
 *   (مع إعادة الوضع) لبناء مسارات وهمية واقعية.
 * ══════════════════════════════════════════════════════════════════════════
 */
import { Logger } from '../utils/Logger';

function xorshift32(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export interface MonteCarloResult {
  runs:              number;
  tradeCount:        number;
  startBalance:      number;
  // Confidence intervals for final balance
  p5:                number;   // 5th percentile (worst 5%)
  p25:               number;   // 25th percentile
  p50:               number;   // median
  p75:               number;   // 75th percentile
  p95:               number;   // 95th percentile (best 5%)
  // Drawdown statistics
  maxDD_p50:         number;   // median max drawdown
  maxDD_p95:         number;   // worst 5% max drawdown (key risk metric)
  // Probability metrics
  probProfit:        number;   // probability of being profitable
  probDD10pct:       number;   // probability of 10%+ drawdown
  probDD20pct:       number;   // probability of 20%+ drawdown
  probRuin:          number;   // probability of 50%+ drawdown (ruin)
  // Recommended position size multiplier
  safePositionPct:   number;   // recommended % risk per trade given DD95
  // Distribution summaries
  expectedReturn:    number;   // mean % return after N trades
  sharpeEstimate:    number;   // estimated Sharpe from simulations
  kellyFraction:     number;   // Kelly Criterion recommendation
  // Path data (sampled)
  samplePaths:       number[][]; // 20 sample equity curves for visualization
}

export class MonteCarloSimulator {
  private logger = new Logger('MonteCarlo');

  run(
    trades:         { profit: number }[],  // historical trade results
    startBalance  = 10_000,
    simulations   = 10_000,
    futureTrades  = 100,
    seed          = 0x13579bdf,
  ): MonteCarloResult {
    if (trades.length < 10) {
      this.logger.warn('Monte Carlo: insufficient trade history (< 10 trades)');
      return this.emptyResult(startBalance, simulations, futureTrades);
    }

    this.logger.info(`Monte Carlo: ${simulations} runs × ${futureTrades} trades | history=${trades.length}`);

    const profits = trades.map(t => t.profit);
    const finalBalances: number[] = [];
    const maxDrawdowns: number[]  = [];
    const samplePaths: number[][] = [];
    const rng = xorshift32(seed);

    for (let sim = 0; sim < simulations; sim++) {
      const { finalBalance, maxDD, path } = this.simulatePath(
        profits, startBalance, futureTrades, rng
      );
      finalBalances.push(finalBalance);
      maxDrawdowns.push(maxDD);
      if (sim < 20) samplePaths.push(path); // keep 20 sample paths for viz
    }

    finalBalances.sort((a, b) => a - b);
    maxDrawdowns.sort((a, b) => a - b);

    const p = (arr: number[], pct: number) => arr[Math.floor(arr.length * pct / 100)];

    const p50Balance = p(finalBalances, 50);
    const maxDD_p95  = p(maxDrawdowns, 95);

    // Probability calculations
    const probProfit  = finalBalances.filter(b => b > startBalance).length / simulations;
    const probDD10    = maxDrawdowns.filter(d => d > 0.10).length / simulations;
    const probDD20    = maxDrawdowns.filter(d => d > 0.20).length / simulations;
    const probRuin    = maxDrawdowns.filter(d => d > 0.50).length / simulations;

    // Safe position size: if worst 5% DD is X%, keep risk per trade ≤ 1%/X
    const safePositionPct = maxDD_p95 > 0
      ? Math.min(0.02, 0.02 / (maxDD_p95 / 0.10))
      : 0.01;

    // Kelly Criterion
    const wins    = profits.filter(p => p > 0);
    const losses  = profits.filter(p => p <= 0);
    const winRate = wins.length / profits.length;
    const avgWin  = wins.length  ? wins.reduce((s, v)  => s + v, 0)  / wins.length  : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 1;
    const bRatio  = avgLoss > 0 ? avgWin / avgLoss : 0;
    const kelly   = bRatio > 0 ? (winRate * bRatio - (1 - winRate)) / bRatio : 0;

    // Sharpe estimate from simulations
    const returnPcts = finalBalances.map(b => (b - startBalance) / startBalance);
    const meanReturn = returnPcts.reduce((s, v) => s + v, 0) / returnPcts.length;
    const stdReturn  = Math.sqrt(returnPcts.reduce((s, v) => s + Math.pow(v - meanReturn, 2), 0) / returnPcts.length);
    const sharpe     = stdReturn > 0 ? meanReturn / stdReturn : 0;

    return {
      runs:            simulations,
      tradeCount:      futureTrades,
      startBalance,
      p5:              p(finalBalances, 5),
      p25:             p(finalBalances, 25),
      p50:             p50Balance,
      p75:             p(finalBalances, 75),
      p95:             p(finalBalances, 95),
      maxDD_p50:       p(maxDrawdowns, 50),
      maxDD_p95,
      probProfit,
      probDD10pct:     probDD10,
      probDD20pct:     probDD20,
      probRuin,
      safePositionPct: Math.max(0.005, Math.round(safePositionPct * 1000) / 1000),
      expectedReturn:  meanReturn * 100,
      sharpeEstimate:  +sharpe.toFixed(3),
      kellyFraction:   +Math.max(0, Math.min(0.25, kelly)).toFixed(4),
      samplePaths,
    };
  }

  private simulatePath(
    profits: number[],
    startBalance: number,
    steps: number,
    rng: () => number,
  ): { finalBalance: number; maxDD: number; path: number[] } {
    let balance = startBalance;
    let peak    = startBalance;
    let maxDD   = 0;
    const path  = [startBalance];
    const n     = profits.length;

    for (let i = 0; i < steps; i++) {
      // Bootstrap: reproducible pseudo-random sample from historical profits.
      const randomProfit = profits[Math.floor(rng() * n)];
      balance += randomProfit;
      balance  = Math.max(0, balance); // can't go below 0
      if (balance > peak) peak = balance;
      const dd = peak > 0 ? (peak - balance) / peak : 0;
      if (dd > maxDD) maxDD = dd;
      path.push(+balance.toFixed(2));
    }

    return { finalBalance: balance, maxDD, path };
  }

  private emptyResult(startBalance: number, simulations: number, tradeCount: number): MonteCarloResult {
    return {
      runs: simulations, tradeCount, startBalance,
      p5: startBalance, p25: startBalance, p50: startBalance, p75: startBalance, p95: startBalance,
      maxDD_p50: 0, maxDD_p95: 0,
      probProfit: 0, probDD10pct: 0, probDD20pct: 0, probRuin: 0,
      safePositionPct: 0.01, expectedReturn: 0, sharpeEstimate: 0, kellyFraction: 0,
      samplePaths: [],
    };
  }

  /** Human-readable summary */
  summarize(result: MonteCarloResult): string {
    const { p50, p95, p5, maxDD_p95, probProfit, probRuin, kellyFraction, safePositionPct } = result;
    const startBal = result.startBalance;

    return (
      `📊 Monte Carlo (${result.runs.toLocaleString()} runs × ${result.tradeCount} trades)\n` +
      `\n` +
      `💰 Projected Balance (after ${result.tradeCount} trades):\n` +
      `   Best 5%:   $${p95.toFixed(0)} (+${((p95-startBal)/startBal*100).toFixed(1)}%)\n` +
      `   Median:    $${p50.toFixed(0)} (+${((p50-startBal)/startBal*100).toFixed(1)}%)\n` +
      `   Worst 5%:  $${p5.toFixed(0)} (${((p5-startBal)/startBal*100).toFixed(1)}%)\n` +
      `\n` +
      `📉 Max Drawdown (95th percentile): ${(maxDD_p95*100).toFixed(1)}%\n` +
      `✅ Probability of Profit: ${(probProfit*100).toFixed(1)}%\n` +
      `⚠️  Probability of Ruin (>50% DD): ${(probRuin*100).toFixed(1)}%\n` +
      `\n` +
      `🎯 Recommendations:\n` +
      `   Kelly Fraction: ${(kellyFraction*100).toFixed(1)}%\n` +
      `   Safe Risk/Trade: ${(safePositionPct*100).toFixed(2)}%`
    );
  }
}
