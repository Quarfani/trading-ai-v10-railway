/**
 * Tests: SessionFilter
 */
import { SessionFilter } from '../risk/SessionFilter';

const UTC = (h: number) => {
  const d = new Date(); d.setUTCHours(h, 0, 0, 0); return d.getTime();
};

describe('SessionFilter', () => {
  const f = new SessionFilter();

  test('OVERLAP session at 14:00 UTC', () => {
    expect(f.currentSession(UTC(14))).toBe('OVERLAP');
  });

  test('LONDON session at 10:00 UTC', () => {
    expect(f.currentSession(UTC(10))).toBe('LONDON');
  });

  test('NEWYORK session at 18:00 UTC', () => {
    expect(f.currentSession(UTC(18))).toBe('NEWYORK');
  });

  test('TOKYO session at 03:00 UTC', () => {
    expect(f.currentSession(UTC(3))).toBe('TOKYO');
  });

  test('DEAD_ZONE at 23:00 UTC', () => {
    expect(f.currentSession(UTC(23))).toBe('DEAD_ZONE');
  });

  test('TREND engine allowed in LONDON', () => {
    const r = f.check('TREND', 'EURUSD', UTC(10));
    expect(r.allowed).toBe(true);
  });

  test('TREND engine blocked in DEAD_ZONE', () => {
    const r = f.check('TREND', 'EURUSD', UTC(23));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Dead zone');
  });

  test('non-JPY blocked in TOKYO', () => {
    const r = f.check('TREND', 'EURUSD', UTC(4));
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('TOKYO');
  });

  test('JPY pair allowed in TOKYO', () => {
    const r = f.check('RSI', 'USDJPY', UTC(4));
    expect(r.allowed).toBe(true);
  });
});
