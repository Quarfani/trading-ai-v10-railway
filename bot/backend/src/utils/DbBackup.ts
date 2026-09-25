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

      // 1. Flush any WAL pages before copying the file. The application keeps
      // the database in WAL mode; copying a live file without checkpointing
      // can otherwise produce an incomplete backup.
      const db = (await import('better-sqlite3')).default;
      const handle = new db(this.dbPath);
      try {
        handle.pragma('wal_checkpoint(FULL)');
      } finally {
        handle.close();
      }
      const sourceSize = fs.statSync(this.dbPath).size;
      if (sourceSize > MAX_BACKUP_BYTES) throw new Error(`Database backup exceeds safety limit: ${sourceSize} bytes`);
      fs.copyFileSync(this.dbPath, localDst);
      this.logger.info(`Local backup: ${localDst}`);

      // 2. Encrypt if key provided
      let uploadPath = localDst;
      if (this.encKey) {
        uploadPath = localDst + '.enc';
        this.encryptFile(localDst, uploadPath);
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

  private encryptFile(src: string, dst: string) {
    const key = crypto.scryptSync(this.encKey!, 'trading-ai-backup-v2', 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const input = fs.readFileSync(src);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(dst, Buffer.concat([Buffer.from('TAIB2'), iv, tag, ciphertext]));
  }

  private async uploadToS3(localFile: string, remoteKey: string): Promise<void> {
    const cfg = this.s3Config!;
    const data = fs.readFileSync(localFile);
    const date = new Date().toUTCString();

    // Simple PUT request (works with S3-compatible APIs)
    return new Promise((resolve, reject) => {
      const url    = new URL(`${cfg.endpoint}/${cfg.bucket}/${remoteKey}`);
      const req    = https.request({
        hostname: url.hostname,
        path:     url.pathname,
        method:   'PUT',
        headers: {
          'Content-Length': data.length,
          'Content-Type':   'application/octet-stream',
          'Date':           date,
          // Note: Full AWS Signature v4 should be implemented for production
          // This is a simplified version for Cloudflare R2 / compatible APIs
          'Authorization':  `Bearer ${cfg.accessKey}`,
        },
      }, res => {
        if (res.statusCode && res.statusCode < 300) resolve();
        else reject(new Error(`S3 upload failed: ${res.statusCode}`));
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  private pruneLocal(backupDir: string) {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('db-backup-'))
      .sort()
      .reverse();

    for (const f of files.slice(MAX_LOCAL_COPIES)) {
      fs.unlinkSync(path.join(backupDir, f));
      this.logger.debug(`Pruned old backup: ${f}`);
    }
  }
}
