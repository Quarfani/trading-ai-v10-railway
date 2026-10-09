/**
 * RATE LIMITER — ENHANCED
 * [NEW] Per-IP sliding window (100 req/min default)
 * [NEW] Burst protection: max 20 requests in 5 seconds
 * [NEW] Auto-ban IP after 5 consecutive rate-limit violations
 * [NEW] Whitelist for localhost
 */
import { Request, Response, NextFunction } from 'express';
import { Logger } from '../utils/Logger';
import { getClientIp } from './clientIp';

interface IPState {
  requests:   number[];  // timestamps of requests in current window
  violations: number;    // rate limit violation count
  bannedUntil: number;
}

const logger    = new Logger('RateLimit');
const state     = new Map<string, IPState>();
const WHITELIST = new Set(['127.0.0.1', '::1', 'localhost']);

export function rateLimit(maxPerMin = 100, namespace = 'global') {
  const WINDOW_MS = 60_000;
  const BURST_MS  = 5_000;
  const BURST_MAX = 20;
  const BAN_MS    = 10 * 60_000; // 10 min ban

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);

    // Whitelist
    if (WHITELIST.has(ip)) return next();

    const stateKey = `${namespace}:${ip}`;
    const now  = Date.now();
    let   info = state.get(stateKey);
    if (!info) {
      info = { requests: [], violations: 0, bannedUntil: 0 };
      state.set(stateKey, info);
    }

    // Banned?
    if (now < info.bannedUntil) {
      res.setHeader('Retry-After', String(Math.ceil((info.bannedUntil - now) / 1000)));
      return res.status(429).json({ error: 'IP temporarily banned due to abuse' });
    }

    // Prune old timestamps
    info.requests = info.requests.filter(t => now - t < WINDOW_MS);

    // Per-minute limit
    if (info.requests.length >= maxPerMin) {
      info.violations++;
      if (info.violations >= 5) {
        info.bannedUntil = now + BAN_MS;
        logger.warn(`IP ${ip} banned for 10min (${info.violations} violations)`);
        return res.status(429).json({ error: 'IP banned — too many violations' });
      }
      logger.warn(`Rate limit: ${ip} (${info.requests.length}/${maxPerMin} rpm, violations=${info.violations})`);
      res.setHeader('X-RateLimit-Limit', String(maxPerMin));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    // Burst protection
    const burstCount = info.requests.filter(t => now - t < BURST_MS).length;
    if (burstCount >= BURST_MAX) {
      return res.status(429).json({ error: 'Burst limit exceeded — slow down' });
    }

    info.requests.push(now);
    info.violations = Math.max(0, info.violations - 0.1); // decay violations slowly

    res.setHeader('X-RateLimit-Limit', String(maxPerMin));
    res.setHeader('X-RateLimit-Remaining', String(maxPerMin - info.requests.length));
    next();
  };
}

// Cleanup stale IPs every 10 minutes
setInterval(() => {
  const now   = Date.now();
  const prune = now - 120_000; // 2 min inactivity
  for (const [ip, info] of state) {
    const last = info.requests[info.requests.length - 1] ?? 0;
    if (last < prune && now > info.bannedUntil) state.delete(ip);
  }
}, 10 * 60_000);
