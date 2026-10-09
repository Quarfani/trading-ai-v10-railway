import { getClientIp } from '../api/clientIp';

type TestCase = { name: string; run: () => void };

function request(headers: Record<string, string | undefined>, remoteAddress: string): any {
  return { headers, socket: { remoteAddress } };
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${String(expected)} actual=${String(actual)}`);
  }
}

function main() {
  const original = process.env.TRUST_RAILWAY_X_REAL_IP;
  let passed = 0;
  let failed = 0;
  const tests: TestCase[] = [
    {
      name: 'ignores a forged X-Forwarded-For loopback address by default',
      run: () => {
        process.env.TRUST_RAILWAY_X_REAL_IP = 'false';
        equal(
          getClientIp(request({ 'x-forwarded-for': '127.0.0.1' }, '198.51.100.7')),
          '198.51.100.7',
          'untrusted forwarding header must not select the client key',
        );
      },
    },
    {
      name: 'does not trust X-Real-IP unless Railway ingress trust is explicitly enabled',
      run: () => {
        process.env.TRUST_RAILWAY_X_REAL_IP = 'false';
        equal(
          getClientIp(request({ 'x-real-ip': '127.0.0.1' }, '198.51.100.8')),
          '198.51.100.8',
          'untrusted real-IP header must be ignored',
        );
      },
    },
    {
      name: 'uses a valid Railway X-Real-IP only when explicitly enabled',
      run: () => {
        process.env.TRUST_RAILWAY_X_REAL_IP = 'true';
        equal(
          getClientIp(request({ 'x-real-ip': '203.0.113.22' }, '100.64.0.3')),
          '203.0.113.22',
          'trusted Railway ingress address should identify the client',
        );
      },
    },
    {
      name: 'rejects malformed or comma-separated trusted-header values',
      run: () => {
        process.env.TRUST_RAILWAY_X_REAL_IP = 'true';
        equal(
          getClientIp(request({ 'x-real-ip': '127.0.0.1, 203.0.113.2' }, '100.64.0.4')),
          '100.64.0.4',
          'invalid trusted-header input must fall back to the socket peer',
        );
      },
    },
    {
      name: 'normalizes IPv4-mapped IPv6 loopback addresses',
      run: () => {
        process.env.TRUST_RAILWAY_X_REAL_IP = 'false';
        equal(
          getClientIp(request({}, '::ffff:127.0.0.1')),
          '127.0.0.1',
          'mapped loopback address must normalize before allowlist checks',
        );
      },
    },
  ];

  try {
    for (const test of tests) {
      try {
        test.run();
        passed += 1;
      } catch (error: any) {
        failed += 1;
        console.error(`FAIL: ${test.name}: ${error?.message ?? String(error)}`);
      }
    }
  } finally {
    if (original === undefined) delete process.env.TRUST_RAILWAY_X_REAL_IP;
    else process.env.TRUST_RAILWAY_X_REAL_IP = original;
  }

  console.log(`Result: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
