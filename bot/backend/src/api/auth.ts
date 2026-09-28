/**
 * AUTH — HMAC session token + lightweight RBAC.
 *
 * Dashboard password remains the ADMIN credential. A separate
 * OPERATOR_PASSWORD can be configured for trading-control actions.
 * Live/Testnet modes require the operator credential to be distinct.
 */
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

export type Role = 'admin' | 'operator';

declare global {
  namespace Express {
    interface Request { user?: { role: Role }; }
  }
}

const PASSWORD = process.env.DASHBOARD_PASSWORD ?? '';
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD ?? '';
const SECRET = process.env.SESSION_SECRET ?? '';

if (!PASSWORD || PASSWORD.length < 12) {
  throw new Error('[Auth] DASHBOARD_PASSWORD is missing or too short (minimum 12 characters).');
}
if (SECRET.length < 32) {
  throw new Error('[Auth] SESSION_SECRET is missing or too short (minimum 32 characters).');
}
const TTL = Number(process.env.TOKEN_TTL_SECONDS ?? 28800);
if (!Number.isFinite(TTL) || TTL < 300 || TTL > 86400) {
  throw new Error('[Auth] TOKEN_TTL_SECONDS must be between 300 and 86400 seconds.');
}

const liveMode = (process.env.MODE ?? 'paper') !== 'paper';
if (liveMode) {
  if (!OPERATOR_PASSWORD || OPERATOR_PASSWORD.length < 12) {
    throw new Error('[Auth] OPERATOR_PASSWORD is required (>=12 chars) in non-paper modes.');
  }
  if (OPERATOR_PASSWORD === PASSWORD) {
    throw new Error('[Auth] OPERATOR_PASSWORD must differ from DASHBOARD_PASSWORD.');
  }
}

const EFFECTIVE_SECRET = SECRET;
const BACKUP_API_TOKEN = process.env.BACKUP_API_TOKEN ?? '';
if (BACKUP_API_TOKEN && BACKUP_API_TOKEN.length < 32) {
  throw new Error('[Auth] BACKUP_API_TOKEN must be at least 32 characters when configured.');
}

function safeTokenEquals(left: string, right: string): boolean {
  if (!left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60_000;

function sign(payload: string): string {
  const sig = crypto.createHmac('sha256', EFFECTIVE_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verify(token: string): { valid: boolean; expired: boolean; role?: Role } {
  const i = token.lastIndexOf('.');
  if (i < 0) return { valid: false, expired: false };
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', EFFECTIVE_SECRET).update(payload).digest('hex');

  let ok = true;
  try {
    const actualBuf = Buffer.from(sig, 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    ok = actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch { ok = false; }
  if (!ok) return { valid: false, expired: false };

  const [issuedAt, , roleRaw] = payload.split(':');
  const role = roleRaw === 'admin' || roleRaw === 'operator' ? roleRaw : undefined;
  const age = Date.now() - Number(issuedAt);
  if (!role || !Number.isFinite(age) || age < -30_000) return { valid: false, expired: false };
  if (age > TTL * 1000) return { valid: false, expired: true };
  return { valid: true, expired: false, role };
}

export function login(req: Request, res: Response) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const bucket = loginAttempts.get(ip);

  if (bucket && now < bucket.resetAt && bucket.count >= MAX_ATTEMPTS) {
    const wait = Math.ceil((bucket.resetAt - now) / 60_000);
    return res.status(429).json({ error: `Too many attempts. Try again in ${wait} min.` });
  }

  const { password } = req.body ?? {};
  let role: Role | null = null;
  if (password === PASSWORD) role = 'admin';
  else if (OPERATOR_PASSWORD && password === OPERATOR_PASSWORD) role = 'operator';

  if (!role) {
    const b = bucket && now < bucket.resetAt ? bucket : { count: 0, resetAt: now + WINDOW_MS };
    b.count++;
    loginAttempts.set(ip, b);
    return res.status(401).json({ error: 'Wrong password' });
  }

  loginAttempts.delete(ip);
  const payload = `${Date.now()}:${crypto.randomBytes(8).toString('hex')}:${role}`;
  res.json({ token: sign(payload), expiresIn: TTL, role });
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const PUBLIC = ['/', '/api/auth/login', '/api/health', '/health', '/ready', '/liveness'];
  if (PUBLIC.includes(req.path)) return next();

  const backupHeader = req.header('x-backup-token') ?? '';
  if (req.path === '/api/backup/sqlite' && safeTokenEquals(backupHeader, BACKUP_API_TOKEN)) {
    req.user = { role: 'admin' };
    return next();
  }
  const auth = req.header('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { valid, expired, role } = verify(token);
  if (expired) return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
  if (!valid || !role) return res.status(401).json({ error: 'Invalid token' });

  req.user = { role };
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role', required: roles });
    }
    next();
  };
}
