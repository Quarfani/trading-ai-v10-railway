/**
 * DB BACKUP — LOCAL + REMOTE (S3-compatible)
 * يحفظ نسخة محلية كل 6 ساعات
 * ويرفع نسخة مشفرة إلى S3 / Cloudflare R2 / Backblaze B2
 */
import fs       from 'fs';
import path     from 'path';
import crypto   from 'crypto';
import https    from 'https';
import { Logger } from './Logger';
import { pipeline } from 'node:stream/promises';

export interface S3SigV4Headers {
  authorization: string;
  amzDate: string;
  payloadHash: string;
  signedHeaders: string;
  host: string;
  scope: string;
}

function hmacSha256(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

export function createS3SigV4Headers(
  url: URL,
  accessKey: string,
  secretKey: string,
  region: string,
  payloadHash: string,
  now: Date = new Date(),
): S3SigV4Headers {
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('S3 endpoint must be an HTTPS URL without credentials, query, or fragment');
  }
  if (!accessKey.trim() || !secretKey.trim() || !/^[A-Za-z0-9-]+$/.test(region)) {
    throw new Error('S3 SigV4 requires a non-empty access key, secret key, and valid region');
  }
  if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new Error('S3 SigV4 payload SHA-256 must be 64 lowercase hexadecimal characters');
  }
  if (!Number.isFinite(now.getTime())) {
    throw new Error('S3 SigV4 signing time is invalid');
  }

  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = url.host.toLowerCase();
  const canonicalUri = url.pathname || '/';
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const canonicalRequest = [
    'PUT',
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');

  const dateKey = hmacSha256(Buffer.from(`AWS4${secretKey}`, 'utf8'), dateStamp);
  const regionKey = hmacSha256(dateKey, region);
  const serviceKey = hmacSha256(regionKey, 's3');
  const signingKey = hmacSha256(serviceKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey)
    .update(stringToSign, 'utf8')
    .digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, amzDate, payloadHash, signedHeaders, host, scope };
}

const MAX_LOCAL_COPIES = 6;

const BACKUP_INTERVAL  = 6 * 3_600_000; // 6 hours
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

export class DbBackup {
  private logger   = new Logger('DbBackup');
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private dbPath:      string,
    private s3Config?: {
      endpoint:   string;  // e.g. https://s3.amazonaws.com
      bucket:     string;
      accessKey:  string;
      secretKey:  string;
      region:     string;
    },
    private encKey?: string, // AES-256 encryption key (32 chars)
  ) {}

  start() {
    const backupDir = path.join(path.dirname(this.dbPath), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    this.runBackup(); // immediate first run
    this.interval = setInterval(() => this.runBackup(), BACKUP_INTERVAL);
    this.logger.info(`Backup started — every ${BACKUP_INTERVAL / 3_600_000}h`);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
  }

  private async runBackup() {
    try {
      const ts       = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `db-backup-${ts}.sqlite`;
      const backupDir = path.join(path.dirname(this.dbPath), 'backups');
      const localDst = path.join(backupDir, filename);

      // 1. Create a transactionally consistent snapshot, including committed WAL data.
      const db = (await import('better-sqlite3')).default;
      const handle = new db(this.dbPath);
      try {
        const escapedPath = localDst.replace(/'/g, "''");
        handle.exec(`VACUUM INTO '${escapedPath}'`);
      } finally {
        handle.close();
      }
      const snapshotSize = fs.statSync(localDst).size;
      if (!(snapshotSize > 0) || snapshotSize > MAX_BACKUP_BYTES) {
        fs.rmSync(localDst, { force: true });
        throw new Error(`Database snapshot size is invalid or exceeds the safety limit: ${snapshotSize} bytes`);
      }
      this.logger.info(`Local backup snapshot: ${localDst} (${snapshotSize} bytes)`);

      // 2. Encrypt if key provided
      let uploadPath = localDst;
      if (this.encKey) {
        uploadPath = localDst + '.enc';
        await this.encryptFile(localDst, uploadPath);
        fs.rmSync(localDst, { force: true });
        this.logger.info(`Encrypted backup: ${uploadPath}`);
      }

      // 3. Upload to S3 if configured
      if (this.s3Config) {
        await this.uploadToS3(uploadPath, filename + (this.encKey ? '.enc' : ''));
        this.logger.info(`Remote backup uploaded to S3: ${this.s3Config.bucket}/${filename}`);
      }

      // 4. Prune old local backups
      this.pruneLocal(backupDir);

    } catch (e: any) {
      this.logger.error(`Backup failed: ${e.message}`);
    }
  }

  private async encryptFile(src: string, dst: string): Promise<void> {
    const key = crypto.scryptSync(this.encKey!, 'trading-ai-backup-v2', 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encryptedTemp = `${dst}.cipher-${crypto.randomBytes(8).toString('hex')}`;

    try {
      await pipeline(
        fs.createReadStream(src),
        cipher,
        fs.createWriteStream(encryptedTemp, { flags: 'wx' }),
      );

      const tag = cipher.getAuthTag();
      const output = fs.createWriteStream(dst, { flags: 'wx' });
      output.write(Buffer.concat([Buffer.from('TAIB2'), iv, tag]));
      await pipeline(fs.createReadStream(encryptedTemp), output);
    } catch (error) {
      fs.rmSync(dst, { force: true });
      throw error;
    } finally {
      fs.rmSync(encryptedTemp, { force: true });
    }
  }

  private async uploadToS3(localFile: string, remoteKey: string): Promise<void> {
    const cfg = this.s3Config!;
    const stat = fs.statSync(localFile);
    if (!stat.isFile() || !(stat.size > 0) || stat.size > MAX_BACKUP_BYTES) {
      throw new Error('S3 upload source is not a valid backup file within the size limit');
    }

    const url = new URL(cfg.endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('S3_ENDPOINT must be an HTTPS URL without credentials, query, or fragment');
    }
    const encodeSegment = (value: string) =>
      encodeURIComponent(value).replace(/[!'()*]/g, char =>
        `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
    const basePath = url.pathname.replace(/\/+$/, '');
    const objectPath = `${basePath}/${encodeSegment(cfg.bucket)}/${remoteKey.split('/').map(encodeSegment).join('/')}`;
    url.pathname = objectPath;

    const payloadHash = await new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const input = fs.createReadStream(localFile);
      input.on('data', (chunk: Buffer) => hash.update(chunk));
      input.once('error', reject);
      input.once('end', () => resolve(hash.digest('hex')));
    });
    const signing = createS3SigV4Headers(
      url,
      cfg.accessKey,
      cfg.secretKey,
      cfg.region,
      payloadHash,
    );

    await new Promise<void>((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname,
        method: 'PUT',
        headers: {
          Host: signing.host,
          'Content-Length': stat.size,
          'Content-Type': 'application/octet-stream',
          'x-amz-content-sha256': signing.payloadHash,
          'x-amz-date': signing.amzDate,
          Authorization: signing.authorization,
        },
      }, res => {
        res.resume();
        res.once('end', () => {
          const status = Number(res.statusCode ?? 0);
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`S3 SigV4 upload failed with HTTP status ${status}`));
        });
        res.once('error', reject);
      });

      req.setTimeout(120_000, () => req.destroy(new Error('S3 upload timed out')));
      req.once('error', reject);
      const input = fs.createReadStream(localFile);
      input.once('error', error => req.destroy(error));
      input.pipe(req);
    });
  }

  private pruneLocal(backupDir: string) {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('db-backup-'));
    const groups = new Map<string, string[]>();

    for (const file of files) {
      const snapshotKey = file
        .replace(/\.enc$/, '')
        .replace(/\.sqlite$/, '');
      const group = groups.get(snapshotKey) ?? [];
      group.push(file);
      groups.set(snapshotKey, group);
    }

    const snapshotKeys = [...groups.keys()].sort().reverse();
    for (const snapshotKey of snapshotKeys.slice(MAX_LOCAL_COPIES)) {
      for (const file of groups.get(snapshotKey) ?? []) {
        fs.unlinkSync(path.join(backupDir, file));
        this.logger.debug(`Pruned old backup file: ${file}`);
      }
    }
  }
}
