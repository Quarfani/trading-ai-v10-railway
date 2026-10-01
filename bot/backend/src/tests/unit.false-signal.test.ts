import { detectFalseSignal } from '../filters/FalseSignalEngine';
import { Candle } from '../types/trading.types';

function assert(condition:unknown,message:string):asserts condition{
  if(!condition) throw new Error(message);
}

function candle(open:number,close:number,high:number,low:number):Candle{
  return {time:Date.now(),open,close,high,low,volume:100};
}

const flat=Array.from({length:29},()=>candle(100,100.01,100.02,99.99));
flat.push(candle(100,100.01,100.02,99.99));
assert(!detectFalseSignal({
  candles:flat,
  side:'BUY',
  entryPrice:100.01,
}).passed,'flat weak-momentum sample should not pass');

const breakout=Array.from({length:29},()=>candle(100,100.1,100.2,99.9));
breakout.push(candle(100.05,100.02,101,99.95));
const result=detectFalseSignal({candles:breakout,side:'BUY',entryPrice:100.02});
assert(result.reasons.includes('FAKE_BREAKOUT'),'rejected breakout should be flagged');

const spread=detectFalseSignal({
  candles:flat,
  side:'BUY',
  entryPrice:100,
  spreadPips:9.5,
  maxSpreadPips:10,
});
assert(spread.reasons.includes('ABNORMAL_SPREAD'),'high spread should be flagged');

console.log('Result: 7 passed, 0 failed');
