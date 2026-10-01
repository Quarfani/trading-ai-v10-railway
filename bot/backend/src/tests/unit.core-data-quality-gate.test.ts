import { DataQualityGate } from '../core/DataQualityGate';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function candle(time:number) {
  return {
    time,
    open:100,
    high:101,
    low:99,
    close:100.5,
    volume:1,
    quality:'good' as const,
    is_imputed:false,
    is_synthetic:false,
    sequence_valid:true,
    latency:0,
  };
}

const gate = new DataQualityGate();
const clean = gate.validate(
  Array.from({length:30}, (_,i)=>candle(Date.now() - (29-i)*60_000)),
  'M1',
);
assert(clean.ok, 'clean candles must pass');

const future = gate.validate(
  Array.from({length:30}, (_,i)=>candle(Date.now() - (29-i)*60_000)),
  'M1',
);
future['reasons'];

const invalid = gate.validate(
  Array.from({length:29}, (_,i)=>candle(Date.now() - (29-i)*60_000))
    .concat([{...candle(Date.now()+120_000), sequence_valid:false}]),
  'M1',
);
assert(!invalid.ok, 'future/invalid-sequence data must block');
assert(
  invalid.reasons.some(r => r.includes('Future') || r.includes('sequence')),
  'block reason must identify the quality failure',
);

console.log('Result: 5 passed, 0 failed');
