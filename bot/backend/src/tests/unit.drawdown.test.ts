/**
 * Tests: DrawdownScaler
 */
import { DrawdownScaler } from '../risk/DrawdownScaler';

const mockDb = {
  getSetting: () => null,
  setSetting: () => {},
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

  test('drawdownPct is 0 when at peak', () => {
    const s = new DrawdownScaler(mockDb, 10000);
    const r = s.getStatus(10000);
    expect(r.drawdownPct).toBe(0);
  });
});
