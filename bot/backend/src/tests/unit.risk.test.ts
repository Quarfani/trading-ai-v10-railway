import { validateRiskReward } from '../risk/RiskManager';
/**
 * UNIT TESTS — Risk Components
 */
export {};

import { CircuitBreaker }    from '../risk/CircuitBreaker';
import { DailyLossGuard }    from '../risk/DailyLossGuard';
import { CorrelationFilter } from '../risk/CorrelationFilter';
import { SpreadFilter }      from '../risk/SpreadFilter';
import { Trade }             from '../types/trading.types';

let ok = 0, fail = 0;
function assert(c: boolean, label: string) {
  if (c) { console.log(`  ✅  ${label}`); ok++; }
  else   { console.error(`  ❌  ${label}`); fail++; }
}

// ─── CircuitBreaker ───────────────────────────────────────────────────────────

console.log('\n═══ CircuitBreaker ═══');
{
  const cb = new CircuitBreaker(3, 60_000, null as any);

  assert(cb.canTrade(),  'New breaker: can trade');
  cb.recordResult(-10);
  cb.recordResult(-20);
  assert(cb.canTrade(),  'After 2 losses: can still trade');
  cb.recordResult(-30);
  assert(!cb.canTrade(), 'After 3 losses: tripped');

  cb.recordResult(+50);
  assert(cb.canTrade(),  'Win resets consecutive loss count');

  // Re-trip
  cb.recordResult(-1);
  cb.recordResult(-2);
  cb.recordResult(-3);
  assert(!cb.canTrade(), 'Tripped again after 3 more losses');
}

// ─── CorrelationFilter ────────────────────────────────────────────────────────

console.log('\n═══ CorrelationFilter ═══');
{
  const cf = new CorrelationFilter();
  const openTrades: Trade[] = [
    { symbol: 'GBPUSD', side: 'BUY', volume: 0.1, entry: 1.27, sl: 1.26, tp: 1.29,
      status: 'open', openedAt: Date.now(), source: 'TREND' },
  ];

  // EURUSD and GBPUSD are correlated
  const r1 = cf.isCorrelated('EURUSD', 'BUY', openTrades);
  assert(r1.blocked,  'EURUSD BUY blocked: GBPUSD BUY already open (correlated)');

  // Opposite direction is fine
  const r2 = cf.isCorrelated('EURUSD', 'SELL', openTrades);
  assert(!r2.blocked, 'EURUSD SELL allowed: opposite direction to GBPUSD BUY');

  // Unrelated symbol is fine
  const r3 = cf.isCorrelated('USDJPY', 'BUY', openTrades);
  assert(!r3.blocked, 'USDJPY BUY allowed: no correlation with GBPUSD');

  // No open trades — always allowed
  const r4 = cf.isCorrelated('EURUSD', 'BUY', []);
  assert(!r4.blocked, 'Always allowed when no open trades');
}

// ─── SpreadFilter ─────────────────────────────────────────────────────────────

console.log('\n═══ SpreadFilter ═══');
{
  const sf = new SpreadFilter();

  // EURUSD max spread = 2 pips
  const r1 = sf.check('EURUSD', 1.08000, 1.08015); // 1.5 pips
  assert(r1.ok,  'EURUSD 1.5 pip spread: OK');

  const r2 = sf.check('EURUSD', 1.08000, 1.08030); // 3 pips
  assert(!r2.ok, 'EURUSD 3 pip spread: blocked');

  // XAUUSD max = 50 pips
  const r3 = sf.check('XAUUSD', 2000.00, 2000.20); // 2 pips
  assert(r3.ok,  'XAUUSD 2 pip spread: OK');
  const r4 = sf.check('XAUUSD', 2000.00, 2005.00); // 50 pips
  assert(!r4.ok, 'XAUUSD 50 pip spread: blocked');
}

// ??? Risk/Reward Gate ?????????????????????????????????????????????????????????
console.log('\n??? Risk/Reward Gate ???');
{
  // Reproduce the bad ETHUSDT signal seen in Railway:
  // entry=2689.05, SL=2667.4008, TP=2690.2151 => R:R?0.054
  const weak = validateRiskReward(
    { price: 2689.05, sl: 2667.4008, tp: 2690.2151 },
    1.5,
  );

  assert(!weak.valid, 'R:R 0.054 is blocked');
  assert(weak.rr < 0.1, 'Weak signal R:R is correctly calculated');

  const valid = validateRiskReward(
    { price: 100, sl: 99, tp: 101.5 },
    1.5,
  );

  assert(valid.valid, 'R:R 1.50 is accepted');

  const zeroRisk = validateRiskReward(
    { price: 100, sl: 100, tp: 102 },
    1.5,
  );

  assert(!zeroRisk.valid, 'Zero SL distance is blocked');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════');
if (fail === 0) console.log(`✅  RISK UNITS PASS — all ${ok} assertions`);
else console.error(`❌  ${fail} FAILURE(S) — ${ok} passed`);
console.log('══════════════════════════════════════════════\n');
if (fail > 0) process.exit(1);
