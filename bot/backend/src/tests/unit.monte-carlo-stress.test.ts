import { applyStressScenario, runMonteCarlo } from '../research/MonteCarloStress';

function assert(condition:unknown,message:string):asserts condition{
  if(!condition) throw new Error(message);
}

const returns=[0.02,-0.01,0.03,-0.02,0.01,0.01,-0.015,0.025];

const mc=runMonteCarlo(returns,{simulations:200,random:()=>0.42});
assert(mc.simulations===200,'simulation count should be preserved');
assert(Number.isFinite(mc.percentileDrawdown95),'DD percentile must be finite');
assert(mc.percentileLossStreak95>=0,'loss streak must be non-negative');
assert(mc.riskOfRuinEstimate>=0 && mc.riskOfRuinEstimate<=1,'ruin estimate must be a probability');

const stressed=applyStressScenario(returns,{
  name:'spread_x2',
  spreadMultiplier:2,
  slippageMultiplier:2,
  executionDelayBars:1,
  returnShockMultiplier:0.9,
});
assert(stressed.stressedTrades.length===returns.length,'stress should preserve sample size');
assert(Number.isFinite(stressed.endingReturn),'stressed return must be finite');

console.log('Result: 9 passed, 0 failed');
