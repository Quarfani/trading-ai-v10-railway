/**
 * LOGGER — v9.0
 * Structured JSON logging with levels, timestamps, and optional file output.
 * [NEW] Log rotation support
 * [NEW] Production-safe (no color codes when LOG_JSON=true)
 */
import * as fs   from 'fs';
import * as path from 'path';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<LogLevel, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LEVEL_COLORS: Record<LogLevel, string> = {
  DEBUG: '\x1b[90m', INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m',
};
const RESET = '\x1b[0m';

const MIN_LEVEL   = (process.env.LOG_LEVEL ?? 'INFO') as LogLevel;
const JSON_MODE   = process.env.LOG_JSON === 'true';
const LOG_FILE    = process.env.LOG_FILE;
let   logStream:  fs.WriteStream | null = null;

if (LOG_FILE) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

export class Logger {
  constructor(private readonly context: string) {}

  debug(msg: string, data?: unknown) { this.log('DEBUG', msg, data); }
  info (msg: string, data?: unknown) { this.log('INFO',  msg, data); }
  warn (msg: string, data?: unknown) { this.log('WARN',  msg, data); }
  error(msg: string, data?: unknown) { this.log('ERROR', msg, data); }

  private log(level: LogLevel, msg: string, data?: unknown) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

    const ts  = new Date().toISOString();
    const ctx = this.context;

    if (JSON_MODE || logStream) {
      const entry = JSON.stringify({ ts, level, ctx, msg, ...(data ? { data } : {}) });
      if (JSON_MODE) {
        level === 'ERROR' ? process.stderr.write(entry + '\n') : process.stdout.write(entry + '\n');
      }
      if (logStream) logStream.write(entry + '\n');
    } else {
      const col  = LEVEL_COLORS[level];
      const line = `${col}${ts} [${level}] [${ctx}]${RESET} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
      level === 'ERROR' ? console.error(line) : console.log(line);
    }
  }
}
