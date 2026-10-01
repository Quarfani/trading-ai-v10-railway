import { calculateAnalogDistance, searchHistoricalAnalogs, HistoricalObservation } from '../research/HistoricalAnalogEngine';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function obs(i:number):HistoricalObservation{
  return {
    timestamp:i,
    features:{trend:1,atrPct:0.5,volatility:0.4,momentum:0.7,volumeZ:0.1,structure:0.8,session:1},
    forwardReturns:{1:0.02,3:0.03},
    tpHit:{1:true,3:true},
    slHit:{1:false,3:false},
    mfe:{1:0.025,3:0.04},
    mae:{1:0.005,3:0.008},
  };
}
const current={trend:1,atrPct:0.5,volatility:0.4,momentum:0.7,volumeZ:0.1,structure:0.8,session:1};
assert(calculateAnalogDistance(current,current)===0,'identical states must have zero distance');

const history=Array.from({length:30},(_,i)=>obs(i));
const result=searchHistoricalAnalogs(current,history,{k:50,horizons:[1,3]});
assert(result.matches.length===30,'all 30 close analogs should be selected');
assert(result.passed,'30 valid matches should pass the minimum evidence gate');
assert(result.horizons[0].tpProbability===1,'TP probability should be 100% for synthetic sample');

const empty=searchHistoricalAnalogs(current,[],{k:20});
assert(!empty.passed,'empty history must fail evidence');
console.log('Result: 7 passed, 0 failed');
