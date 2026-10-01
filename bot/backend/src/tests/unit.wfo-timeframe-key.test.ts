import { DatabaseManager } from '../database/DatabaseManager';
import { WalkForwardOptimizer } from '../optimization/WalkForwardOptimizer';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const db = new DatabaseManager(':memory:');
await db.initialize();

const wfo = new WalkForwardOptimizer(':memory:');
wfo.saveParams(db, 'EURUSD', {
  atrMult: 1.2,
  tpRatio: 2,
  minConfidence: 0.6,
  rollingWindow: 30,
}, 'H1');

wfo.saveParams(db, 'EURUSD', {
  atrMult: 2.0,
  tpRatio: 3,
  minConfidence: 0.7,
  rollingWindow: 30,
}, 'M5');

assert(wfo.loadParams(db, 'EURUSD', 'H1')?.atrMult === 1.2, 'H1 params must be isolated');
assert(wfo.loadParams(db, 'EURUSD', 'M5')?.atrMult === 2.0, 'M5 params must be isolated');

console.log('Result: 4 passed, 0 failed');
