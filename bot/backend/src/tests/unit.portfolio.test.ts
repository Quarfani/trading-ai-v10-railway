import { PortfolioHeat } from '../risk/PortfolioHeat';
import { Trade, SystemConfig } from '../types/trading.types';

const mockConfig = { maxPortfolioHeat: 0.06, accountBalance: 10000 } as unknown as SystemConfig;
const mockTrade = (symbol: string, vol: number, entry: number, sl: number): Trade => ({
  id: 1, symbol, side: 'BUY', volume: vol, entry, sl, tp: entry + 0.01,
  status: 'open', source: 'TEST', openedAt: Date.now(),
});

describe('PortfolioHeat', () => {
  test('allows trade within heat limit', () => {
    const ph = new PortfolioHeat(mockConfig);
    const r  = ph.check([], 0.1, 1.2000, 1.1900, 'EURUSD', 10000);
    expect(r.allowed).toBe(true);
  });

  test('blocks trade exceeding heat limit', () => {
    const ph = new PortfolioHeat(mockConfig);
    const open = [
      mockTrade('EURUSD', 2.0, 1.2000, 1.1500), // 5% risk
      mockTrade('GBPUSD', 2.0, 1.3000, 1.2500),
    ];
    const r = ph.check(open, 0.5, 1.2000, 1.1900, 'USDJPY', 10000);
    expect(r.allowed).toBe(false);
  });

  test('currentHeat is calculated correctly', () => {
    const ph   = new PortfolioHeat(mockConfig);
    const open = [mockTrade('EURUSD', 0.1, 1.2000, 1.1900)]; // 0.01 * 0.1 * 100000 = $100 = 1%
    const r    = ph.check(open, 0.01, 1.2000, 1.1950, 'GBPUSD', 10000);
    expect(r.currentHeat).toBeGreaterThan(0);
    expect(r.currentHeat).toBeLessThan(0.06);
  });
});
