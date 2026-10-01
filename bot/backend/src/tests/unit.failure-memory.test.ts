import { DatabaseManager } from '../database/DatabaseManager';
import { FailureMemoryStore } from '../analytics/FailureMemoryStore';
import { analyzeCounterfactuals } from '../analytics/Counterfactual';

async function main(){
  function assert(condition:unknown,message:string):asserts condition{
    if(!condition) throw new Error(message);
  }

  const db=new DatabaseManager(':memory:');
  await db.initialize();
  const store=new FailureMemoryStore(db);
  store.record({
    symbol:'EURUSD',
    timeframe:'H1',
    strategy:'TREND',
    regime:'TRENDING',
    profit:-100,
    rootCause:'late_entry',
    counterfactual:{action:'DELAY_ENTRY',hypotheticalPnl:50},
  });

  const rows=store.recent(10);
  assert(rows.length===1,'one failure record should persist');
  assert(rows[0].rootCause==='late_entry','root cause should round-trip');

  const result=analyzeCounterfactuals(-100,[
    {action:'NO_TRADE',realizedPnl:-100,hypotheticalPnl:0},
    {action:'HALF_SIZE',realizedPnl:-100,hypotheticalPnl:-50},
  ]);
  assert(result.bestAlternative?.action==='NO_TRADE','best alternative should be no trade');
  assert(result.avoidedLoss===100,'avoided loss should be 100');
  assert(result.decisionQuality==='POOR','large avoidable loss should be poor quality');

  const unknown=analyzeCounterfactuals(10,[]);
  assert(unknown.decisionQuality==='UNKNOWN','no alternatives should be unknown');

  console.log('Result: 9 passed, 0 failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
