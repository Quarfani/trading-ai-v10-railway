import { rateLimit } from '../api/rateLimit';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type ResponseState = {
  statusCode: number;
  headers: Record<string, string>;
  body?: unknown;
};

function response(state: ResponseState): any {
  const target: any = {
    setHeader(name: string, value: string) {
      state.headers[name.toLowerCase()] = value;
      return target;
    },
    status(code: number) {
      state.statusCode = code;
      return target;
    },
    json(body: unknown) {
      state.body = body;
      return target;
    },
  };
  return target;
}

function invoke(middleware: ReturnType<typeof rateLimit>, req: any): { nextCalls: number; response: ResponseState } {
  const state: ResponseState = { statusCode: 200, headers: {} };
  let nextCalls = 0;
  middleware(req, response(state), () => { nextCalls += 1; });
  return { nextCalls, response: state };
}

function main(): void {
  const original = process.env.TRUST_RAILWAY_X_REAL_IP;
  let passed = 0;

  try {
    process.env.TRUST_RAILWAY_X_REAL_IP = 'true';
    const proxyRateLimit = rateLimit(1, 'test-proxy-loopback-spoof');
    const spoofedProxyRequest = {
      headers: {
        'x-real-ip': '127.0.0.1',
        'x-forwarded-for': '127.0.0.1',
      },
      socket: { remoteAddress: '198.51.100.41' },
    };

    const first = invoke(proxyRateLimit, spoofedProxyRequest);
    assert(first.nextCalls === 1, 'first request should pass through');
    passed += 1;

    const second = invoke(proxyRateLimit, spoofedProxyRequest);
    assert(second.nextCalls === 0, 'a proxy-header loopback value must not bypass the rate limiter');
    passed += 1;
    assert(second.response.statusCode === 429, 'the second request should be rejected by the configured limit');
    passed += 1;

    process.env.TRUST_RAILWAY_X_REAL_IP = 'false';
    const localRateLimit = rateLimit(1, 'test-local-loopback');
    const localRequest = {
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    };
    const localFirst = invoke(localRateLimit, localRequest);
    const localSecond = invoke(localRateLimit, localRequest);
    assert(localFirst.nextCalls === 1 && localSecond.nextCalls === 1,
      'socket-authenticated local loopback traffic should retain its local development exemption');
    passed += 1;
  } finally {
    if (original === undefined) delete process.env.TRUST_RAILWAY_X_REAL_IP;
    else process.env.TRUST_RAILWAY_X_REAL_IP = original;
  }

  console.log(`Result: ${passed} passed, 0 failed`);
}

main();
