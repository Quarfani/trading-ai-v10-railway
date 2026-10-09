import { isIP } from 'node:net';
import type { Request } from 'express';

function normalizeIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (!ip || ip.includes(',') || /\s/.test(ip)) return null;

  if (ip.toLowerCase().startsWith('::ffff:')) {
    const mappedIpv4 = ip.slice(7);
    if (isIP(mappedIpv4) === 4) return mappedIpv4;
  }

  return isIP(ip) > 0 ? ip.toLowerCase() : null;
}

/**
 * Resolves a rate-limit key without trusting caller-controlled forwarding headers.
 *
 * Railway's public HTTP edge documents X-Real-IP as the remote client address.
 * Only use that header when the deployment explicitly opts in and traffic is
 * routed through Railway public HTTP ingress. Railway private-network requests
 * can bypass edge header sanitization; do not rely on this header for untrusted
 * private callers. Never infer trust from X-Forwarded-For.
 */
export function getClientIp(req: Pick<Request, 'headers' | 'socket'>): string {
  if (String(process.env.TRUST_RAILWAY_X_REAL_IP ?? '').toLowerCase() === 'true') {
    const trustedIp = normalizeIp(req.headers['x-real-ip']);
    if (trustedIp) return trustedIp;
  }

  return normalizeIp(req.socket?.remoteAddress) ?? 'unknown';
}
