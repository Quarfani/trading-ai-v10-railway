import { selectConfirmationTimeframes } from '../core/MultiTimeframeConfirm';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const m5 = selectConfirmationTimeframes('M5');
assert(m5.length === 2, 'M5 must have two confirmations');
assert(m5[0] === 'M15' && m5[1] === 'M30', 'M5 should use M15/M30');

const h1 = selectConfirmationTimeframes('H1');
assert(h1[0] === 'H4' && h1[1] === 'D1', 'H1 should use H4/D1');

const d1 = selectConfirmationTimeframes('D1');
assert(d1[0] === 'H4' && d1[1] === 'H1', 'D1 should fall back to nearest lower frames');

console.log('Result: 6 passed, 0 failed');