import { NewsFilter } from '../risk/NewsFilter';

async function main(){
  function assert(condition:unknown,message:string):asserts condition{
    if(!condition) throw new Error(message);
  }

  const filter=new NewsFilter();
  assert(!filter.isFresh(),'new filter must be stale until a calendar is fetched');

  const blocked=filter.isBlocked('EURUSD',Date.now());
  assert(!blocked.blocked,'empty calendar should not invent an event');

  console.log('Result: 4 passed, 0 failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
