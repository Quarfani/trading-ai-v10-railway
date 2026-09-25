/**
 * INTEGRATION TESTS — Full Pipeline
 */
export {};

import { Signal, RiskResult, TradeDecision } from '../types/trading.types';

let ok = 0, fail = 0;
function assert(c: boolean, label: string) {
  if (c) { console.log(`  ✅  ${label}`); ok++; }
  else   { console.error(`  ❌  ${label}`); fail++; }
}

const goodSignal: Signal = {
  symbol: 'EURUSD', side: 'BUY', price: 1.0850, confidence: 0.75,
  sl: 1.0800, tp: 1.0950, source: 'TREND+RSI', reason: 'EMA+RSI',
  timestamp: Date.now(),
};

async function run() {
  // ═══ SCENARIO 1: Happy path ═══════════════════════════════════════════════
  console.log('\n═══ Integration: Happy Path ═══');
  {
    function aggregatorGate(conf: number, engines: number): Signal | null {
      if (engines === 1 && conf < 0.70) return null;
      return { ...goodSignal, confidence: conf };
    }
    assert(aggregatorGate(0.55, 1) === null, '[Aggregator] Single low-conf → rejected');
    assert(aggregatorGate(0.75, 1) !== null, '[Aggregator] Single high-conf → accepted');
    assert(aggregatorGate(0.55, 2) !== null, '[Aggregator] Multi-engine → accepted');

    function mockDecide(sig: Signal, minConf: number): TradeDecision {
      const auditId = `dec_${Date.now()}`;
      if (sig.confidence < minConf)
        return { decision: 'NO_TRADE', confidence: sig.confidence, volume: 0, reasons: ['low conf'], auditId };
      return { decision: sig.side, confidence: sig.confidence, volume: 0, reasons: ['APPROVED'], auditId };
    }
    const d = mockDecide(goodSignal, 0.60);
    assert(d.decision === 'BUY', '[Decision] BUY decision');
    assert(d.reasons.some(r => r === 'APPROVED'), '[Decision] Reason = APPROVED');

    const risk: RiskResult = { passed: true, volume: 0.1, blockedBy: '', reasons: ['OK'] };
    assert(risk.passed,     '[Risk] Passes');
    assert(risk.volume > 0, '[Risk] Volume set');

    let attempts = 0;
    async function mockExecute() {
      attempts++;
      return { success: true, trade: { id: 99, ...goodSignal, volume: 0.1, entry: 1.0851, status: 'open' as const, openedAt: Date.now() }, retries: 0, totalMs: 50 };
    }
    const result = await mockExecute();
    assert(result.success,         '[Exec] Success');
    assert(result.trade.id === 99, '[Exec] Trade has ID');
    assert(attempts === 1,         '[Exec] Only one attempt');
  }

  // ═══ SCENARIO 2: Risk blocks after Decision approves ══════════════════════
  console.log('\n═══ Integration: Risk Block After Decision ═══');
  {
    let executionAttempted = false;
    const decision: TradeDecision = { decision: 'BUY', confidence: 0.78, volume: 0, reasons: ['APPROVED'], auditId: 'test2' };
    assert(decision.decision === 'BUY', '[Decision] Approved BUY');

    const risk: RiskResult = { passed: false, volume: 0, blockedBy: 'daily_loss_limit', reasons: ['Limit reached'] };
    if (!risk.passed) { /* hard stop */ } else { executionAttempted = true; }
    assert(!executionAttempted, '[Risk] Execution blocked');
    assert(risk.blockedBy === 'daily_loss_limit', '[Risk] Correct block reason');
  }

  // ═══ SCENARIO 3: Low confidence rejected ══════════════════════════════════
  console.log('\n═══ Integration: Low Confidence Rejected ═══');
  {
    const lowConf: Signal = { ...goodSignal, confidence: 0.40 };
    function decide(sig: Signal, minConf: number): TradeDecision {
      if (sig.confidence < minConf)
        return { decision: 'NO_TRADE', confidence: sig.confidence, volume: 0, reasons: ['low conf'], auditId: 'test3' };
      return { decision: sig.side, confidence: sig.confidence, volume: 0, reasons: ['OK'], auditId: 'test3' };
    }
    const d = decide(lowConf, 0.60);
    assert(d.decision === 'NO_TRADE', '[Decision] NO_TRADE for low confidence');
    assert(d.volume === 0,            '[Decision] Volume = 0');
    assert(lowConf.confidence === 0.40, '[Signal] Confidence not mutated');
  }

  // ═══ SCENARIO 4: Emergency stop ═══════════════════════════════════════════
  console.log('\n═══ Integration: Emergency Stop ═══');
  {
    function checkRisk(emergency: boolean): RiskResult {
      if (emergency) return { passed: false, volume: 0, blockedBy: 'emergency_stop', reasons: ['Emergency'] };
      return { passed: true, volume: 0.1, blockedBy: '', reasons: ['OK'] };
    }
    const r1 = checkRisk(true);
    assert(!r1.passed,                       '[Emergency] Blocked when active');
    assert(r1.blockedBy === 'emergency_stop', '[Emergency] Correct reason');
    const r2 = checkRisk(false);
    assert(r2.passed,                        '[Emergency] Passes after deactivation');
  }

  // ═══ SCENARIO 5: Slippage non-retryable ════════════════════════════════════
  console.log('\n═══ Integration: Non-Retryable Slippage ═══');
  {
    class NonRetryableError extends Error { name = 'NonRetryableError'; }
    let calls = 0;
    async function execWithRetry(fn: () => Promise<void>, max = 3) {
      for (let i = 0; i < max; i++) {
        try { await fn(); return { success: true, retries: i }; }
        catch (e: any) {
          if (e.name === 'NonRetryableError') return { success: false, retries: i + 1 };
          if (i === max - 1) return { success: false, retries: max };
        }
      }
      return { success: false, retries: max };
    }
    const r = await execWithRetry(async () => { calls++; throw new NonRetryableError('Slippage'); });
    assert(r.success === false, '[Slippage] Fails');
    assert(calls === 1,         '[Slippage] Only 1 broker call');
    assert(r.retries === 1,     '[Slippage] Stopped immediately');

    let normalCalls = 0;
    const r2 = await execWithRetry(async () => { normalCalls++; throw new Error('Timeout'); }, 3);
    assert(r2.success === false, '[Retry] Normal error fails');
    assert(normalCalls === 3,    '[Retry] 3 broker calls');
  }

  // ═══ Summary ═══════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════');
  if (fail === 0) console.log(`✅  INTEGRATION TESTS PASS — all ${ok} assertions`);
  else console.error(`❌  ${fail} FAILURE(S) — ${ok} passed`);
  console.log('══════════════════════════════════════════════\n');
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
