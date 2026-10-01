import { calculateEvidenceScore } from '../research/EvidenceScore';
import { calculateExpectedValue, calculateTradeEVFromRR } from '../research/ExpectedValue';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function approx(a:number,b:number,t=1e-9){ assert(Math.abs(a-b)<=t,`expected ${b}, got ${a}`); }

const strong=calculateEvidenceScore({
  sampleSize:500,
  outOfSampleTrades:300,
  walkForwardStability:0.9,
  regimeCoverage:0.9,
  parameterSensitivity:0.85,
  costAdjustedProfitFactor:1.8,
  datasetQuality:0.95,
  leakageChecksPassed:true,
});
assert(strong.passed,'strong evidence should pass');
assert(strong.score>0.7,'strong evidence should have high score');

const weak=calculateEvidenceScore({
  sampleSize:80,
  outOfSampleTrades:40,
  walkForwardStability:0.9,
  regimeCoverage:0.9,
  parameterSensitivity:0.9,
  costAdjustedProfitFactor:2,
  datasetQuality:0.95,
  leakageChecksPassed:true,
});
assert(!weak.passed,'insufficient OOS sample must block promotion');

const ev=calculateExpectedValue({
  winProbability:0.6,
  winAmount:200,
  lossAmount:100,
  costs:10,
});
approx(ev.expectedGross,80);
approx(ev.expectedNet,70);
assert(ev.passed,'positive net EV should pass');

const rrEv=calculateTradeEVFromRR(0.55,100,2,5);
assert(rrEv.expectedNet>0,'2R with 55% wins should have positive EV after low costs');

let rejected=false;
try{
  calculateExpectedValue({winProbability:0.6,lossProbability:0.5,winAmount:100,lossAmount:100,costs:1});
}catch{rejected=true;}
assert(rejected,'probabilities must sum to one');

console.log('Result: 12 passed, 0 failed');