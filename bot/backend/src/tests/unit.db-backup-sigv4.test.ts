import { createS3SigV4Headers } from '../utils/DbBackup';

let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed += 1;
}

function expectThrow(run: () => unknown, message: string): void {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

function main(): void {
  const url = new URL('https://s3.example.test/bucket/backups/file.sqlite');
  const bodyHash = 'a'.repeat(64);
  const fixedDate = new Date('2026-10-09T12:34:56.000Z');

  const headers = createS3SigV4Headers(
    url,
    'test-access',
    'test-secret',
    'us-east-1',
    bodyHash,
    fixedDate,
  );

  assert(headers.amzDate === '20261009T123456Z', 'SigV4 date must use AWS basic ISO-8601 format');
  assert(headers.scope === '20261009/us-east-1/s3/aws4_request', 'SigV4 scope must include date, region, service, and terminator');
  assert(headers.host === 's3.example.test', 'SigV4 host must match the requested host');
  assert(headers.signedHeaders === 'host;x-amz-content-sha256;x-amz-date', 'SigV4 signed headers must be stable and sorted');
  assert(
    headers.authorization === 'AWS4-HMAC-SHA256 Credential=test-access/20261009/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=789874b62af0784e9a82a82b2f778e8b8bd7ff08f070de457b91f748f72678d7',
    'SigV4 authorization must match the independently calculated deterministic vector',
  );

  const repeat = createS3SigV4Headers(
    new URL('https://s3.example.test/bucket/backups/file.sqlite'),
    'test-access',
    'test-secret',
    'us-east-1',
    bodyHash,
    fixedDate,
  );
  assert(repeat.authorization === headers.authorization, 'same request inputs must produce the same signature');

  const changedBody = createS3SigV4Headers(
    new URL('https://s3.example.test/bucket/backups/file.sqlite'),
    'test-access',
    'test-secret',
    'us-east-1',
    'b'.repeat(64),
    fixedDate,
  );
  assert(changedBody.authorization !== headers.authorization, 'changing the payload hash must change the signature');

  expectThrow(
    () => createS3SigV4Headers(new URL('http://s3.example.test/bucket/file'), 'key', 'secret', 'us-east-1', bodyHash, fixedDate),
    'SigV4 must reject non-HTTPS endpoints',
  );
  expectThrow(
    () => createS3SigV4Headers(new URL('https://s3.example.test/bucket/file?x=1'), 'key', 'secret', 'us-east-1', bodyHash, fixedDate),
    'SigV4 must reject query-bearing endpoints',
  );
  expectThrow(
    () => createS3SigV4Headers(url, 'key', 'secret', '', bodyHash, fixedDate),
    'SigV4 must reject a missing region',
  );
  expectThrow(
    () => createS3SigV4Headers(url, 'key', 'secret', 'us-east-1', 'invalid', fixedDate),
    'SigV4 must reject malformed payload hashes',
  );
  expectThrow(
    () => createS3SigV4Headers(url, 'key', 'secret', 'us-east-1', bodyHash, new Date(Number.NaN)),
    'SigV4 must reject invalid signing times',
  );

  console.log(`Result: ${passed} passed, 0 failed`);
}

main();
