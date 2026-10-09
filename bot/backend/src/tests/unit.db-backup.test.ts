import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DbBackup } from '../utils/DbBackup';

let passed = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed += 1;
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-ai-db-backup-test-'));
  try {
    const databasePath = path.join(tmp, 'trading.db');
    const inputPath = path.join(tmp, 'snapshot.sqlite');
    const encryptedPath = path.join(tmp, 'snapshot.sqlite.enc');
    const original = Buffer.alloc(256 * 1024);
    for (let i = 0; i < original.length; i++) original[i] = (i * 31 + 17) % 251;
    fs.writeFileSync(inputPath, original);

    const backup = new DbBackup(databasePath, undefined, 'unit-test-backup-encryption-key');
    await (backup as any).encryptFile(inputPath, encryptedPath);

    const encrypted = fs.readFileSync(encryptedPath);
    assert(encrypted.subarray(0, 5).toString('ascii') === 'TAIB2',
      'AES-GCM encrypted backup must preserve the TAIB2 file signature');
    assert(encrypted.length === original.length + 33,
      'TAIB2 envelope must contain 5-byte magic, 12-byte IV, 16-byte tag, and ciphertext');

    const key = crypto.scryptSync('unit-test-backup-encryption-key', 'trading-ai-backup-v2', 32);
    const iv = encrypted.subarray(5, 17);
    const tag = encrypted.subarray(17, 33);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(encrypted.subarray(33)),
      decipher.final(),
    ]);
    assert(decrypted.equals(original),
      'streamed AES-GCM backup must round-trip byte-for-byte');
    assert(!fs.readdirSync(tmp).some(name => name.includes('.cipher-')),
      'temporary ciphertext staging files must be removed after encryption');

    const retentionDir = path.join(tmp, 'retention');
    fs.mkdirSync(retentionDir);
    for (let day = 1; day <= 7; day++) {
      const date = String(day).padStart(2, '0');
      const stem = `db-backup-2026-10-${date}T00-00-00-000Z.sqlite`;
      fs.writeFileSync(path.join(retentionDir, stem), 'plain');
      fs.writeFileSync(path.join(retentionDir, `${stem}.enc`), 'encrypted');
    }

    (backup as any).pruneLocal(retentionDir);
    const retained = fs.readdirSync(retentionDir).sort();
    assert(retained.length === 12,
      'retention must keep six snapshot groups rather than six individual files');
    assert(!retained.some(name => name.includes('2026-10-01')),
      'retention must prune both representations of the oldest snapshot');
    assert(retained.some(name => name === 'db-backup-2026-10-07T00-00-00-000Z.sqlite.enc'),
      'retention must keep the newest encrypted snapshot');

    console.log(`Result: ${passed} passed, 0 failed`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
