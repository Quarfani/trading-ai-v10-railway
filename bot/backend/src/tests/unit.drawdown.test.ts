/**
 * Tests: DrawdownScaler
 */
import { DrawdownScaler } from '../risk/DrawdownScaler';

const state = new Map<string, string>();
const mockDb = {
  getSetting: (key: string) => state.get(key) ?? null,
  setSetting: (key: string, value: string) => { state.set(key, value); },
} as any;

describe('DrawdownScaler', () => {
  test('NORMAL at < 3% drawdown', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(9800); // 2% DD
    expect(r.level).toBe('NORMAL');
    expect(r.volumeScale).toBe(1.0);
  });

  test('WARNING at 3-5% drawdown', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(9600); // 4% DD
    expect(r.level).toBe('WARNING');
    expect(r.volumeScale).toBe(0.70);
  });

  test('DANGER at 5-8% drawdown', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(9300); // 7% DD
    expect(r.level).toBe('DANGER');
    expect(r.volumeScale).toBe(0.40);
  });

  test('STOP at >= 10% drawdown', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(8900); // 11% DD
    expect(r.level).toBe('STOP');
    expect(r.volumeScale).toBe(0.0);
    expect(s.shouldStop(8900)).toBe(true);
  });

  test('updates peak on new equity high', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    s.getStatus(11000); // new high
    const r = s.getStatus(10500); // 4.5% from new peak of 11000
    expect(r.peakEquity).toBe(11000);
    expect(r.drawdownPct).toBeCloseTo(0.045, 2);
  });

  test('persists the peak under an account-scoped key', () => {
    state.clear();
    const first = new DrawdownScaler(mockDb, 10000, false, 'acct-A');
    first.getStatus(12000);

    const sameAccount = new DrawdownScaler(mockDb, 10000, false, 'acct-A');
    const otherAccount = new DrawdownScaler(mockDb, 10000, false, 'acct-B');

    expect(sameAccount.getStatus(11000).peakEquity).toBe(12000);
    expect(otherAccount.getStatus(11000).peakEquity).toBe(11000);
  });

  test('invalid current equity fails closed', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const nan = s.getStatus(Number.NaN);
    expect(nan.level).toBe('STOP');
    expect(nan.volumeScale).toBe(0);

    const zero = s.getStatus(0);
    expect(zero.level).toBe('STOP');
    expect(zero.volumeScale).toBe(0);
  });

  test('invalid persisted peak is ignored or fails closed without producing NaN state', () => {
    state.clear();
    state.set('peak_equity:default', 'not-a-number');
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(10000);
    expect(Number.isFinite(r.peakEquity)).toBe(true);
    expect(r.level).toBe('NORMAL');
  });

  test('drawdownPct is 0 when at peak', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(10000);
    expect(r.drawdownPct).toBe(0);
  });
});
