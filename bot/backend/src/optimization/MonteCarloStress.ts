/**
 * MONTE CARLO STRESS
 * Reproducible bootstrap stress test with explicit friction and recovery-time metrics.
 * This module never chooses trades; it only produces research evidence.
 */

export interface StressTrade {
  profit: number;
  cost?: number;
  notional?: number;
}

export interface MonteCarloStressOptions {
  simulations?: number;
  futureTrades?: number;
  extraCostPerTrade?: number;
  slippageBps?: number;
  seed?: number;
}

export interface MonteCarloStressResult {
  simulations: number;
  futureTrades: number;
  startBalance: number;
  p5FinalBalance: number;
  p50FinalBalance: number;
  p95FinalBalance: number;
  maxDDP50: number;
  maxDDP95: number;
  probabilityLoss: number;
  probabilityDD10: number;
  probabilityDD20: number;
  probabilityRuin: number;
  unrecoveredRate: number;
  recoveryTradesP50: number | null;
  recoveryTradesP95: number | null;
  probabilityRecoveryWithin: Record<string, number>;
}

function percentile(values: number[], pct: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * pct)));
  return sorted[index];
}

function xorshift32(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

export function runMonteCarloStress(
  trades: StressTrade[],
  startBalance = 10_000,
  options: MonteCarloStressOptions = {},
): MonteCarloStressResult {
  const simulations = Math.max(1, Math.floor(options.simulations ?? 5000));
  const futureTrades = Math.max(1, Math.floor(options.futureTrades ?? 200));
  const extraCost = Math.max(0, options.extraCostPerTrade ?? 0);
  const slippageBps = Math.max(0, options.slippageBps ?? 0);

  if (!Number.isFinite(startBalance) || startBalance <= 0) {
    throw new Error("[MonteCarloStress] startBalance must be > 0");
  }
  if (trades.length < 10) {
    throw new Error("[MonteCarloStress] at least 10 historical trades are required");
  }

  const samples = trades.map(trade => {
    if (!Number.isFinite(trade.profit)) throw new Error("[MonteCarloStress] invalid historical profit");
    const baseCost = Number.isFinite(trade.cost) ? Math.max(0, trade.cost as number) : 0;
    const stressSlippage = Number.isFinite(trade.notional)
      ? Math.max(0, trade.notional as number) * slippageBps / 10_000
      : 0;
    return trade.profit - baseCost - extraCost - stressSlippage;
  });

  const rng = xorshift32(options.seed ?? 0x13579bdf);
  const finalBalances: number[] = [];
  const drawdowns: number[] = [];
  const recoveredTimes: number[] = [];
  let unrecovered = 0;
  const recoveryBuckets: Record<string, { ok: number; total: number }> = {
    "25": { ok: 0, total: 0 },
    "50": { ok: 0, total: 0 },
    "100": { ok: 0, total: 0 },
  };

  for (let sim = 0; sim < simulations; sim++) {
    let balance = startBalance;
    let peak = startBalance;
    let maxDD = 0;
    let worstPeak = startBalance;
    let worstPeakAge = 0;
    let worstRecovered = false;

    for (const key of Object.keys(recoveryBuckets)) recoveryBuckets[key].total++;

    for (let step = 1; step <= futureTrades; step++) {
      const sample = samples[Math.floor(rng() * samples.length)];
      balance = Math.max(0, balance + sample);

      if (balance > peak) {
        peak = balance;
      }

      const dd = peak > 0 ? (peak - balance) / peak : 0;
      if (dd > maxDD) {
        maxDD = dd;
        worstPeak = peak;
        worstPeakAge = 0;
        worstRecovered = false;
      } else if (maxDD > 0 && !worstRecovered) {
        worstPeakAge++;
      }

      if (!worstRecovered && maxDD > 0 && balance >= worstPeak) {
        worstRecovered = true;
        recoveredTimes.push(worstPeakAge);
      }

      for (const key of Object.keys(recoveryBuckets)) {
        const n = Number(key);
        if (step >= n) recoveryBuckets[key].total = recoveryBuckets[key].total;
      }
    }

    if (maxDD > 0 && !worstRecovered) unrecovered++;
    finalBalances.push(balance);
    drawdowns.push(maxDD);

    for (const key of Object.keys(recoveryBuckets)) {
      const n = Number(key);
      if (worstRecovered && recoveredTimes[recoveredTimes.length - 1] <= n) {
        recoveryBuckets[key].ok++;
      }
    }
  }

  const total = simulations;
  return {
    simulations,
    futureTrades,
    startBalance,
    p5FinalBalance: percentile(finalBalances, 0.05),
    p50FinalBalance: percentile(finalBalances, 0.50),
    p95FinalBalance: percentile(finalBalances, 0.95),
    maxDDP50: percentile(drawdowns, 0.50),
    maxDDP95: percentile(drawdowns, 0.95),
    probabilityLoss: finalBalances.filter(v => v < startBalance).length / total,
    probabilityDD10: drawdowns.filter(v => v >= 0.10).length / total,
    probabilityDD20: drawdowns.filter(v => v >= 0.20).length / total,
    probabilityRuin: drawdowns.filter(v => v >= 0.50).length / total,
    unrecoveredRate: unrecovered / total,
    recoveryTradesP50: recoveredTimes.length ? percentile(recoveredTimes, 0.50) : null,
    recoveryTradesP95: recoveredTimes.length ? percentile(recoveredTimes, 0.95) : null,
    probabilityRecoveryWithin: Object.fromEntries(
      Object.entries(recoveryBuckets).map(([k, value]) => [k, value.ok / total]),
    ),
  };
}