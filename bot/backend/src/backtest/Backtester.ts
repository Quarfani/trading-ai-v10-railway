/**
 * BACKTESTER — v7.3
 * FIX BUG-C3: orchestrator.process() was called with [] for h4Candles.
 *   The ConsensusOrchestrator uses H4 candles for multi-timeframe
 *   confirmation. With [] the H4 check was always skipped, making
 *   backtests systematically MORE permissive than live trading.
 *   Walk-forward results were therefore unreliable (inflated win-rate).
 *
 * Fix: resample the 1m candle slice into 4h candles on the fly and
 * pass the last 50 H4 candles to the orchestrator.
 *
 * Also carries forward FIX v7.2 (per-symbol commission/spread).
 */
import { Candle, Side, SystemConfig, Timeframe }  from '../types/trading.types';
import { marketRegimeDetector }         from '../core/MarketRegimeDetector';
import { ConsensusOrchestrator }        from '../consensus/ConsensusOrchestrator';
import { DatabaseManager }             from '../database/DatabaseManager';
import { calculateATR }                from '../utils/ATR';
import { getSymbolSpec }               from '../config/symbolConfig';
import { COST_MODEL_VERSION, calculateGrossPnlAccount, estimateCosts } from '../market/CostModel';
import { TIMEFRAME_MS } from '../market/market.types';
import { getCostProfile }              from '../market/CostProfiles';
import { Logger }                      from '../utils/Logger';
import * as path                       from 'path';
import * as fs                         from 'fs';
import * as os                         from 'os';

export interface BacktestTrade {
  symbol: string; side: Side; entry: number; exit: number;
  sl: number; tp: number; size: number; pnl: number; pnlPct: number;
  openedAt: number; closedAt: number;
  exitReason: 'TP' | 'SL' | 'TIMEOUT';
  source: string;
}

export interface MonthlyBreakdown {
  month: string; trades: number; wins: number; pnl: number; winRate: number;
}

export interface BacktestResult {
  symbol: string; timeframe: Timeframe; startBalance: number; endBalance: number;
  totalReturn: number; totalTrades: number; wins: number; losses: number; winRate: number;
  profitFactor: number; expectancy: number; avgWin: number; avgLoss: number; riskReward: number;
  maxDrawdownPct: number; maxDrawdownUsd: number;
  sharpeRatio: number; sortinoRatio: number; calmarRatio: number;
  maxConsecWins: number; maxConsecLosses: number;
  totalCommission: number; totalSpread: number; totalCost: number; costModelVersion: string;
  simulationErrors: number;
  trades: BacktestTrade[]; equityCurve: Array<{ t: number; equity: number }>;
  monthlyBreakdown: MonthlyBreakdown[];
}

const MAX_TRADE_BARS = 200;

// H4 candle duration in milliseconds
const H4_MS = 4 * 60 * 60 * 1000;

/**
 * Resample an array of 1m-ish candles into H4 candles.
 * Groups input candles by 4-hour UTC bucket and OHLCV-aggregates them.
 */
function resampleToH4(candles: Candle[]): Candle[] {
  if (!candles.length) return [];
  const buckets = new Map<number, Candle>();

  for (const c of candles) {
    const bucket = Math.floor(c.time / H4_MS) * H4_MS;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { ...c, time: bucket });
    } else {
      existing.high   = Math.max(existing.high, c.high);
      existing.low    = Math.min(existing.low, c.low);
      existing.close  = c.close;
      existing.volume += c.volume;
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

export class Backtester {
  private logger = new Logger('Backtester');

  constructor(private config: SystemConfig) {}

  async run(symbol: string, candles: Candle[], startBalance = 10_000, timeframe: Timeframe = 'H1'): Promise<BacktestResult> {
    const tmpDb = path.join(os.tmpdir(), `backtest_${Date.now()}.db`);
    const db    = new DatabaseManager(tmpDb);
    await db.initialize();

    const orchestrator = new ConsensusOrchestrator(db, {
      minimum_total_weight: 0.20,
      dominance_ratio:      0.55,
      gate: { min_win_rate: 0, min_sharpe_ratio: -Infinity, min_rolling_expectancy: -Infinity, max_drawdown: Infinity, min_trades_for_gate: Infinity },
    });

    marketRegimeDetector.invalidate(symbol);
    const spec = getSymbolSpec(symbol);
    const costProfile = getCostProfile(symbol);

    const trades: BacktestTrade[]                    = [];
    const equityCurve: Array<{ t: number; equity: number }> = [];
    const monthlyMap = new Map<string, MonthlyBreakdown>();

    let balance   = startBalance;
    let peak      = startBalance;
    let maxDDPct  = 0, maxDDUsd = 0;
    let totalComm = 0, totalSpread = 0, totalCost = 0;
    let simulationErrors = 0;

    let openPos: {
      side: Side; entry: number; sl: number; tp: number;
      size: number; openedAt: number; openBar: number; source: string;
    } | null = null;

    const WARMUP = 250;
    equityCurve.push({ t: candles[0]?.time ?? 0, equity: balance });

    for (let i = WARMUP; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const cur   = slice[slice.length - 1];

      // ── Manage open position ──────────────────────────────────────────
      if (openPos) {
        const hitSL   = openPos.side === 'BUY' ? cur.low  <= openPos.sl : cur.high >= openPos.sl;
        const hitTP   = openPos.side === 'BUY' ? cur.high >= openPos.tp : cur.low  <= openPos.tp;
        const timeout = (i - openPos.openBar) >= MAX_TRADE_BARS;

        if (hitSL || hitTP || timeout) {
          const exitPrice  = hitSL ? openPos.sl : hitTP ? openPos.tp : cur.close;
          const exitReason = hitSL ? 'SL' : hitTP ? 'TP' : 'TIMEOUT';

          const rawPnl = calculateGrossPnlAccount({
            entryPrice: openPos.entry,
            exitPrice,
            volume: openPos.size,
            contractSize: spec.contractSize,
            quoteToAccount: 1,
            side: openPos.side,
          });

          const costs = estimateCosts({
            entryPrice: openPos.entry,
            exitPrice,
            volume: openPos.size,
            contractSize: spec.contractSize,
            quoteToAccount: 1,
          }, costProfile);

          const pnl = rawPnl - costs.total;

          balance += pnl;
          totalComm += costs.commission;
          totalSpread += costs.spread;
          totalCost += costs.total;
          peak         = Math.max(peak, balance);
          const dd     = (peak - balance) / peak;
          maxDDPct     = Math.max(maxDDPct, dd);
          maxDDUsd     = Math.max(maxDDUsd, peak - balance);

          trades.push({
            symbol, source: openPos.source,
            side: openPos.side, entry: openPos.entry, exit: exitPrice,
            sl: openPos.sl, tp: openPos.tp, size: openPos.size,
            pnl, pnlPct: (pnl / startBalance) * 100,
            openedAt: openPos.openedAt, closedAt: cur.time, exitReason,
          });

          const monthKey = new Date(cur.time).toISOString().slice(0, 7);
          const mo = monthlyMap.get(monthKey) ??
            { month: monthKey, trades: 0, wins: 0, pnl: 0, winRate: 0 };
          mo.trades++;
          mo.pnl += pnl;
          if (pnl > 0) mo.wins++;
          mo.winRate = mo.wins / mo.trades;
          monthlyMap.set(monthKey, mo);

          equityCurve.push({ t: cur.time, equity: balance });
          openPos = null;
        }
      }

      // ── Signal generation ─────────────────────────────────────────────
      if (!openPos && i % 4 === 0) {
        try {
          const regime = marketRegimeDetector.detect(symbol, timeframe, slice.slice(-100));
          if (regime.regime === 'VOLATILE') continue;

          // FIX BUG-C3: resample current slice to H4 and pass to orchestrator
          // instead of the empty [] that caused H4 confirmation to be skipped.
          const h4Candles = resampleToH4(slice).slice(0, -1).slice(-50);

          const result = orchestrator.process(symbol, slice, h4Candles, regime.regime, timeframe);
          if (result.outcome === 'NO_TRADE' || !result.signal) continue;

          const sig = result.signal;
          const atr = calculateATR(slice.slice(-50), 14);
          if (!atr) continue;

          const riskPerUnit=Math.abs(sig.price-sig.sl)*spec.contractSize;
          const rawSize=riskPerUnit>0?(balance*0.01)/riskPerUnit:0;
          const size=Math.min(spec.maxVolume,Math.floor(rawSize/spec.volumeStep)*spec.volumeStep);
          if (size>=spec.minVolume) {
            openPos = {
              side: sig.side, entry: cur.close, sl: sig.sl, tp: sig.tp,
              size, openedAt: cur.time, openBar: i, source: sig.source,
            };
          }
        } catch (e) {
          simulationErrors++;
          this.logger.error(`[Backtest] Signal generation failed at ${symbol}/${cur.time}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    try { fs.unlinkSync(tmpDb); } catch { /* pass */ }

    return this.buildResult(
      symbol, timeframe, startBalance, balance, trades, equityCurve,
      Array.from(monthlyMap.values()), maxDDPct, maxDDUsd, totalComm, totalSpread, simulationErrors, totalCost,
    );
  }

  private buildResult(
    symbol: string, timeframe: Timeframe, startBalance: number, balance: number,
    trades: BacktestTrade[], equityCurve: Array<{ t: number; equity: number }>,
    monthlyBreakdown: MonthlyBreakdown[],
    maxDDPct: number, maxDDUsd: number,
    totalCommission: number, totalSpread: number, simulationErrors: number, totalCost: number,
  ): BacktestResult {
    const wins   = trades.filter(t => t.pnl > 0);
    const losses = trades.filter(t => t.pnl <= 0);
    const grossW = wins.reduce((s, t) => s + t.pnl, 0);
    const grossL = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const avgWin  = wins.length   ? grossW / wins.length   : 0;
    const avgLoss = losses.length ? grossL / losses.length : 0;

    const returns   = trades.map(t => t.pnl / startBalance);
    const mean      = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
    const std       = returns.length
      ? Math.sqrt(returns.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / returns.length) : 1;
    const downR     = returns.filter(r => r < 0);
    const downStd   = downR.length
      ? Math.sqrt(downR.reduce((s, v) => s + v * v, 0) / downR.length) : std;
    const durationYears=equityCurve.length>1?Math.max(1/365,(equityCurve[equityCurve.length-1].t-equityCurve[0].t)/(365*24*3_600_000)):1;
    const annFactor=Math.sqrt(Math.max(1,trades.length>1?trades.length/durationYears:1));

    const sharpe  = std    > 0 ? (mean / std)    * annFactor : 0;
    const sortino = downStd > 0 ? (mean / downStd) * annFactor : 0;
    const calmar  = maxDDPct > 0
      ? ((balance - startBalance) / startBalance * 100) / (maxDDPct * 100) : 0;

    let maxWStreak = 0, maxLStreak = 0, wStreak = 0, lStreak = 0;
    for (const t of trades) {
      if (t.pnl > 0) { wStreak++; lStreak = 0; }
      else            { lStreak++; wStreak = 0; }
      maxWStreak = Math.max(maxWStreak, wStreak);
      maxLStreak = Math.max(maxLStreak, lStreak);
    }

    return {
      symbol,
      timeframe,
      startBalance,
      endBalance:      +balance.toFixed(2),
      totalReturn:     +((balance - startBalance) / startBalance * 100).toFixed(2),
      totalTrades:     trades.length,
      wins:            wins.length,
      losses:          losses.length,
      winRate:         trades.length ? +(wins.length / trades.length * 100).toFixed(1) : 0,
      profitFactor:    grossL > 0 ? +(grossW / grossL).toFixed(2) : grossW > 0 ? 99 : 0,
      expectancy:      trades.length ? +mean.toFixed(2) : 0,
      avgWin:          +avgWin.toFixed(2),
      avgLoss:         +avgLoss.toFixed(2),
      riskReward:      avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0,
      maxDrawdownPct:  +(maxDDPct * 100).toFixed(2),
      maxDrawdownUsd:  +maxDDUsd.toFixed(2),
      sharpeRatio:     +sharpe.toFixed(3),
      sortinoRatio:    +sortino.toFixed(3),
      calmarRatio:     +calmar.toFixed(3),
      maxConsecWins:   maxWStreak,
      maxConsecLosses: maxLStreak,
      totalCommission: +totalCommission.toFixed(2),
      totalSpread:     +totalSpread.toFixed(2),
      totalCost:       +totalCost.toFixed(2),
      costModelVersion: COST_MODEL_VERSION,
      trades,
      equityCurve,
      monthlyBreakdown,
      simulationErrors,
    };
  }
}
