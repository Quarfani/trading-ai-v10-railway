import axios from 'axios';
import { NewsFilter } from '../risk/NewsFilter';

async function main(){
  function assert(condition:unknown,message:string):asserts condition{
    if(!condition) throw new Error(message);
  }

  const filter=new NewsFilter();
  assert(!filter.isFresh(),'new filter must be stale until a calendar is fetched');

  const blocked=filter.isBlocked('EURUSD',Date.now());
  assert(!blocked.blocked,'empty calendar should not invent an event');

  const originalGet = (axios as any).get;
  try {
    (axios as any).get = async () => ({
      data: [
        { impact: 'High', date: 'not-a-date', country: 'USD', title: 'CPI' },
      ],
    });
    await filter.refresh();
    assert(
      !filter.isFresh(),
      'malformed high-impact calendar must remain stale/fail-closed',
    );

    const invalidNow = filter.isBlocked('EURUSD', Number.NaN);
    assert(
      invalidNow.blocked,
      'invalid news-check timestamp must fail closed',
    );
  } finally {
    (axios as any).get = originalGet;
  }

  console.log('Result: 6 passed, 0 failed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
