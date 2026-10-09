const ENV_KEYS = [
  'DASHBOARD_PASSWORD',
  'SESSION_SECRET',
  'OPERATOR_PASSWORD',
  'MODE',
  'TOKEN_TTL_SECONDS',
  'TRUST_RAILWAY_X_REAL_IP',
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type ResponseState = { statusCode: number; headers: Record<string, string>; body?: any };

function invoke(login: (req: any, res: any) => unknown, ip: string, password = 'wrong-password'): ResponseState {
  const state: ResponseState = { statusCode: 200, headers: {} };
  const res: any = {
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  login({
    headers: {},
    socket: { remoteAddress: ip },
    body: { password },
  }, res);
  return state;
}

async function main(): Promise<void> {
  const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  try {
    process.env.DASHBOARD_PASSWORD = 'unit-test-dashboard-password-001';
    process.env.SESSION_SECRET = 'unit-test-session-secret-value-long-enough-0001';
    process.env.OPERATOR_PASSWORD = '';
    process.env.MODE = 'paper';
    process.env.TOKEN_TTL_SECONDS = '28800';
    process.env.TRUST_RAILWAY_X_REAL_IP = 'false';

    const { login } = await import('../api/auth');
    const targetIp = '2001:db8::ffff';

    for (let i = 0; i < 10; i++) {
      const response = invoke(login, targetIp);
      assert(response.statusCode === 401, 'first ten invalid attempts should count toward the per-IP throttle');
    }
    const targetThrottled = invoke(login, targetIp);
    assert(targetThrottled.statusCode === 429, 'target IP must be throttled after ten failed attempts');

    // Fill all remaining capacity with distinct recent identities.
    for (let i = 1; i <= 4_999; i++) {
      const response = invoke(login, `2001:db8::${i.toString(16)}`);
      assert(response.statusCode === 401, `new identity ${i} should be recorded while capacity remains`);
    }

    const overflow = invoke(login, '2001:db8::1389');
    assert(overflow.statusCode === 429, 'new identities must fail closed when the login throttle map is full');
    assert(String(overflow.body?.error).includes('capacity reached'), 'capacity response should explain temporary throttling');

    const targetAfterFlood = invoke(login, targetIp);
    assert(targetAfterFlood.statusCode === 429, 'active target throttle must survive a high-cardinality identity flood');
    assert(String(targetAfterFlood.body?.error).includes('Too many attempts'), 'existing per-IP lockout should remain authoritative');

    console.log('Result: 14 passed, 0 failed');
  } finally {
    for (const key of ENV_KEYS) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
