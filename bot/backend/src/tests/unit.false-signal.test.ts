import { detectFalseSignal } from '../filters/FalseSignalEngine';
import { Candle } from '../types/trading.types';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function candle(open:number, close:number, high:number, low:number): Candle {
  return { time: Date.now(), open, close, high, low, volume: 100 };
}

const candles = Array.from({ length: 30 }, () => candle(100, 100.001, 100.02, 99.98));
const result = detectFalseSignal({
  candles,
  side: 'BUY',
  entryPrice: 100.01,
});
assert(result.reasons.includes('WEAK_MOMENTUM'), 'weak momentum should be detected');

const spread = detectFalseSignal({
  candles,
  side: 'BUY',
  entryPrice: 100.01,
  spreadPips: 9.5,
  maxSpreadPips: 10,
});
assert(spread.reasons.includes('ABNORMAL_SPREAD'), 'abnormal spread should be detected');

console.log('Result: 5 passed, 0 failed');
