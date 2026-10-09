import { rateLimit } from '../api/rateLimit';

type ResponseState = { statusCode: number; headers: Record<string, string>; body?: any };

let passed = 0;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed += 1;
}

function invoke(middleware: ReturnType<typeof rateLimit>, ip: string): {
  nextCalls: number;
  response: ResponseState;
} {
  const responseState: ResponseState = { statusCode: 200, headers: {} };
  const response: any = {
    setHeader(name: string, value: string) {
      responseState.headers[name.toLowerCase()] = value;
      return response;
    },
    status(code: number) {
      responseState.statusCode = code;
      return response;
    },
    json(body: unknown) {
      responseState.body = body;
      return response;
    },
  };
  let nextCalls = 0;
  middleware({ headers: {}, socket: { remoteAddress: ip } } as any, response, () => {
    nextCalls += 1;
  });
  return { nextCalls, response: responseState };
}

function main(): void {
  process.env.TRUST_RAILWAY_X_REAL_IP = 'false';
  const middleware = rateLimit(1, 'capacity-protection-test');
  const targetIp = '2001:db8::ffff';

  const first = invoke(middleware, targetIp);
  check(first.nextCalls === 1, 'first target request should be admitted');

  let targetBan: ResponseState | undefined;
  for (let i = 0; i < 5; i++) {
    targetBan = invoke(middleware, targetIp).response;
  }
  check(targetBan?.statusCode === 429, 'target IP should enter a temporary ban after repeated violations');
  check(String(targetBan?.body?.error).includes('banned'), 'target request should report the active ban');

  for (let i = 1; i <= 4_999; i++) {
    const result = invoke(middleware, `2001:db8::${i.toString(16)}`);
    check(result.nextCalls === 1, `identity ${i} should be admitted before map capacity is reached`);
  }

  const overflow = invoke(middleware, '2001:db8::1389');
  check(overflow.nextCalls === 0 && overflow.response.statusCode === 429,
    'new identities must fail closed when the rate-limit state map is full');
  check(String(overflow.response.body?.error).includes('capacity reached'),
    'capacity rejection should be distinguishable from the per-IP rate limit');

  const targetAfterFlood = invoke(middleware, targetIp);
  check(targetAfterFlood.nextCalls === 0 && targetAfterFlood.response.statusCode === 429,
    'high-cardinality traffic must not evict an existing active IP ban');
  check(String(targetAfterFlood.response.body?.error).includes('temporarily banned'),
    'existing ban reason should remain intact after the capacity flood');

  console.log(`Result: ${passed} passed, 0 failed`);
}

main();
