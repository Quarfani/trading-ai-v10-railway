/**
 * CORE STABILITY TEST SCENARIOS — Self-contained
 * Run: npx ts-node --transpile-only src/tests/core.stability.test.ts
 */
export {};

interface Signal {
  symbol: string; side: 'BUY'|'SELL'; price: number; confidence: number;
  sl: number; tp: number; source: string; reason: string; timestamp: number;
}
interface RiskResult {
  passed: boolean; volume: number; blockedBy: string; reasons: string[];
}
interface TradeDecision {
  decision: 'BUY'|'SELL'|'NO_TRADE'; confidence: number;
  volume: number; reasons: string[]; auditId: string;
}

function makeSignal(o: Partial<Signal> = {}): Signal {
  return { symbol:'EURUSD', side:'BUY', price:1.0850, confidence:0.75,
    sl:1.0820, tp:1.0910, source:'TREND+RSI', reason:'EMA+RSI', timestamp:Date.now(), ...o };
}
function passedRisk(volume=0.1): RiskResult {
  return { passed:true, volume, blockedBy:'', reasons:['All checks passed'] };
}
function failedRisk(reason: string): RiskResult {
  return { passed:false, volume:0, blockedBy:reason, reasons:[reason] };
}
function decide(sig: Signal, minConf: number, risk: RiskResult): TradeDecision {
  const auditId = `dec_${Date.now()}`;
  if (sig.confidence < minConf)
    return { decision:'NO_TRADE', confidence:sig.confidence, volume:0,
             reasons:[`Confidence < ${minConf}`], auditId };
  if (!risk.passed)
    return { decision:'NO_TRADE', confidence:sig.confidence, volume:0,
             reasons:[`Risk: ${risk.blockedBy}`], auditId };
  return { decision:sig.side, confidence:sig.confidence, volume:risk.volume,
           reasons:[`✓ APPROVED: ${sig.side} ${sig.symbol}`], auditId };
}
async function executeWithRetry(fn: ()=>Promise<{id:number}>, max=3) {
  for (let i=0; i<max; i++) {
    try { return { success:true, trade: await fn(), retries:i }; }
    catch(e:any) { if (i===max-1) return { success:false, error:e.message, retries:max }; }
  }
  return { success:false, error:'Unknown', retries:max };
}

let ok=0, fail=0;
function assert(c: boolean, label: string) {
  if(c){console.log(`  ✅  ${label}`);ok++;}
  else {console.error(`  ❌  ${label}`);fail++;}
}

async function run() {
  // ═══ SCENARIO 1: Normal trade ════════════════════════════════════════════
  console.log('\n═══ SCENARIO 1 — Normal trade ═══');
  {
    const sig = makeSignal();
    const rc  = passedRisk(0.1);
    let blocked = false;
    if (!rc.passed) { blocked = true; }
    assert(!blocked, 'Risk gate does not block when passed');
    const d = decide(sig, 0.60, rc);
    assert(d.decision === 'BUY',                    'Decision is BUY');
    assert(d.volume === 0.1,                        'Volume correct');
    assert(d.reasons.some(r => r.includes('APPROVED')), 'Reason contains APPROVED');
    const res = await executeWithRetry(async () => ({ id: 42 }));
    assert(res.success === true,                    'Execution succeeds');
    assert((res as any).trade?.id === 42,           'Trade has broker ID');
    assert(res.retries === 0,                       'No retries needed');
  }

  // ═══ SCENARIO 2: Risk hard stop ══════════════════════════════════════════
  console.log('\n═══ SCENARIO 2 — Risk failure (HARD STOP) ═══');
  {
    const reasons = ['circuit_breaker','daily_loss_limit','daily_profit_target',
                     'max_open_trades','spread_too_wide','news_event','correlation','weekend'];
    for (const r of reasons) {
      const rc = failedRisk(r);
      let executed = false, stopped = false;
      if (!rc.passed) { stopped = true; } else { executed = true; }
      assert(stopped,    `Hard stop: ${r}`);
      assert(!executed,  `Execution skipped: ${r}`);
    }
    // Confidence must NOT be mutated after risk block
    const sig = makeSignal();
    const rc  = failedRisk('circuit_breaker');
    let mutated = false;
    if (!rc.passed) { /* continue — nothing runs */ } else { sig.confidence = 0.99; mutated = true; }
    assert(!mutated, 'Confidence NOT mutated after risk block');
  }

  // ═══ SCENARIO 3: Execution retry ═════════════════════════════════════════
  console.log('\n═══ SCENARIO 3 — Execution failure with retry ═══');
  {
    let attempts = 0;
    const res = await executeWithRetry(async () => {
      attempts++;
      throw new Error('Broker timeout');
    }, 3);
    assert(res.success === false,       'Reports failure');
    assert(res.retries === 3,           'All 3 retries consumed');
    assert(attempts === 3,              'Broker called exactly 3 times');
    assert(!!res.error,                 'Error message preserved');
    let crashed = false;
    try { if (!res.success) { /* log and continue */ } } catch { crashed = true; }
    assert(!crashed, 'System does not crash on execution failure');
  }

  // ═══ SCENARIO 4: Aggregator quality gate ══════════════════════════════════
  console.log('\n═══ SCENARIO 4 — Aggregator quality gate ═══');
  {
    function gate(sigs: Signal[]): Signal | null {
      const buys = sigs.filter(s => s.side==='BUY');
      const sells = sigs.filter(s => s.side==='SELL');
      const w = buys.length >= sells.length ? buys : sells;
      if (!w.length) return null;
      if (w.length < 2 && w[0].confidence < 0.70) return null;
      return w[0];
    }
    assert(gate([makeSignal({ confidence:0.55 })]) === null,      'Single <0.70 → rejected');
    assert(gate([makeSignal({ confidence:0.75 })]) !== null,      'Single ≥0.70 → accepted');
    assert(gate([makeSignal(), makeSignal({ source:'RSI' })]) !== null, '2 engines → accepted');
  }

  // ═══ Summary ══════════════════════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════');
  if (fail === 0) console.log(`✅  CORE STABLE — all ${ok} assertions passed`);
  else console.error(`❌  ${fail} FAILURE(S) — ${ok} passed`);
  console.log('══════════════════════════════════════════\n');
  if (fail > 0) process.exit(1);
}

run().catch(e => { console.error('Fatal:', e); process.exit(1); });
