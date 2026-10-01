import { PaperTrader } from '../integration/PaperTrader';
import { Trade, Signal } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, tolerance: number, message: string) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

const originalRandom = Math.random;
Math.random = () => 0.5;

try {
  const initial = 10_000;
  const trader = new PaperTrader(initial);
  const tickets = new Set<number>();

  for (let i = 0; i < 300; i++) {
    const entry = 1.1000 + (i % 7) * 0.0001;
    const signal: Signal = {
      symbol: 'EURUSD',
      side: i % 2 === 0 ? 'BUY' : 'SELL',
      price: entry,
      confidence: 0.8,
      sl: i % 2 === 0 ? entry - 0.005 : entry + 0.005,
      tp: i % 2 === 0 ? entry + 0.010 : entry - 0.010,
      source: 'SOAK',
      reason: 'deterministic-soak',
      timestamp: 1_700_000_000_000 + i,
      timeframe: 'H1',
    };

    const trade = trader.placeOrder(signal, 0.10, 'H1');
    assert(Boolean(trade.ticket), 'every paper trade must receive a ticket');
    assert(!tickets.has(trade.ticket!), 'paper tickets must be unique');
    tickets.add(trade.ticket!);

    if (i % 5 === 0) {
      const partial = trader.partialClose(trade.ticket!, 0.04, signal.side === 'BUY' ? entry + 0.002 : entry - 0.002);
      assert(partial.ok, 'partial close must succeed during soak');
      assert(partial.remainingVolume === 0.06, 'partial close remaining volume must be exact');
    }

    const exit = signal.side === 'BUY'
      ? entry + (i % 3 === 0 ? 0.001 : -0.001)
      : entry - (i % 3 === 0 ? 0.001 : -0.001);
    const closed = trader.closeTrade(trade.ticket!, exit, 'MANUAL');
    assert(closed.ok, 'every paper trade must close during soak');
    assert(Number.isFinite(closed.profit), 'paper profit must remain finite');
  }

  assert(trader.getOpenTrades().length === 0, 'soak must leave no open trades');
  assert(trader.getAllTrades().length === 300, 'soak must retain exactly 300 trade records');

  const stats = trader.getStats();
  assert(stats.trades === 300, 'stats trade count must equal closed trade count');
  assert(stats.wins + stats.losses === 300, 'wins + losses must equal all closed trades');
  assert(Number.isFinite(stats.balance), 'paper balance must remain finite');
  assert(Number.isFinite(stats.maxDrawdownPct) && stats.maxDrawdownPct >= 0, 'max drawdown must remain finite and non-negative');

  const restored = new PaperTrader(initial);
  const closedRows = trader.getAllTrades() as Trade[];
  restored.restoreState([], closedRows);
  assertClose(restored.getBalance(), trader.getBalance(), 1e-8, 'restore balance invariant');
  assert(restored.getOpenTrades().length === 0, 'restored soak must have no open trades');

  const recoveryTrade = new PaperTrader(initial);
  const recoverySignal: Signal = {
    symbol: 'EURUSD', side: 'BUY', price: 1.1000, confidence: 0.8,
    sl: 1.0900, tp: 1.1200, source: 'SOAK', reason: 'recovery',
    timestamp: 1_800_000_000_000, timeframe: 'M5',
  };
  const open = recoveryTrade.placeOrder(recoverySignal, 0.10, 'M5');
  const checkpoint = recoveryTrade.getOpenTrades() as any[];
  const recovered = new PaperTrader(initial);
  recovered.restoreState(checkpoint, []);
  assert(recovered.getOpenTrades().length === 1, 'open position must survive state restore');
  const close = recovered.closeTrade(open.ticket!, 1.1020, 'MANUAL');
  assert(close.ok, 'restored position must remain closable');
  assert(recovered.getOpenTrades().length === 0, 'restored position must be removed after close');

  console.log('Result: 12 passed, 0 failed');
} finally {
  Math.random = originalRandom;
}
