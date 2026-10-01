import { evaluateConviction, orderGatesForEvaluation, GateResult } from '../decision/ConvictionGateEngine';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const passing: GateResult[] = [
  { name:'DATA_QUALITY', status:'PASS', reason:'clean' },
  { name:'REGIME', status:'PASS', reason:'clear' },
  { name:'MTF', status:'PASS', reason:'2/2' },
  { name:'HISTORICAL_ANALOG', status:'PASS', reason:'enough analogs' },
  { name:'EVIDENCE', status:'PASS', reason:'score ok' },
  { name:'EXPECTED_VALUE', status:'PASS', reason:'EV > 0' },
  { name:'RISK_REWARD', status:'PASS', reason:'2R' },
  { name:'FALSE_SIGNAL', status:'PASS', reason:'clear' },
  { name:'PORTFOLIO', status:'PASS', reason:'heat ok' },
  { name:'NEWS_MACRO', status:'PASS', reason:'no high impact event' },
];
assert(evaluateConviction(passing).decision==='TRADE','all gates should pass');

const blocked=evaluateConviction([
  ...passing,
  { name:'DATA_QUALITY', status:'FAIL', reason:'stale data', hardVeto:true },
]);
assert(blocked.decision==='NO_TRADE','data failure must block');
assert(blocked.hardVetoes.includes('DATA_QUALITY'),'hard veto must be surfaced');

const soft=evaluateConviction([
  ...passing,
  { name:'EXPECTED_VALUE', status:'FAIL', reason:'EV below margin' },
]);
assert(soft.decision==='NO_TRADE','any failed gate must block');
assert(soft.failedGates.includes('EXPECTED_VALUE'),'failed gate must be reported');

const ordered=orderGatesForEvaluation(passing);
assert(ordered[0].name==='DATA_QUALITY','highest authority gate should be first');

console.log('Result: 9 passed, 0 failed');
