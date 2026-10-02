/**
 * Tests: KellyPositionSizer — critical financial calculations
 */
import { KellyPositionSizer, SymbolTradeStats } from '../risk/KellyPositionSizer';
import { SystemConfig } from '../types/trading.types';

const mockConfig = {
  accountBalance: 10000,
  riskPerTrade: 0.01,
  compounding: { enabled: false },
} as unknown as SystemConfig;

const goodStats: SymbolTradeStats = {
  trades: 50, winRate: 0.60, avgWin: 150, avgLoss: 100,
};
const badStats: SymbolTradeStats = {
  trades: 50, winRate: 0.30, avgWin: 50, avgLoss: 200,
};
const fewStats: SymbolTradeStats = {
  trades: 5, winRate: 0.80, avgWin: 500, avgLoss: 100,
};

describe('KellyPositionSizer', () => {
  const sizer = new KellyPositionSizer();

  test('falls back to fixed risk when insufficient trades', () => {
    const { volume, stats } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,fewStats,50);
    expect(stats.source).toBe('fixed');
    expect(volume).toBeGreaterThan(0);
  });

  test('uses Kelly when sufficient trades', () => {
    const { volume, stats } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,goodStats,70);
    expect(stats.source).toBe('kelly');
    expect(volume).toBeGreaterThan(0);
  });

  test('negative Kelly fails closed', () => {
    const { volume } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,badStats,50);
    expect(volume).toBe(0);
  });

  test('high quality score produces larger volume than low quality', () => {
    const { volume: volHigh } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,goodStats,85);
    const { volume: volLow }  = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,goodStats,30);
    expect(volHigh).toBeGreaterThanOrEqual(volLow);
  });

  test('volume never exceeds 2× riskPerTrade cap', () => {
    const { volume } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,goodStats,100);
    // Max risk cap: balance * riskPerTrade * 2 / (slDist * contractSize)
    const maxRisk = mockConfig.accountBalance * mockConfig.riskPerTrade * 2;
    const slDist  = 0.01;
    const maxVol  = maxRisk / (slDist * 100000);
    expect(volume).toBeLessThanOrEqual(maxVol + 0.01);
  });

  test('zero SL distance fails closed', () => {
    const { volume } = sizer.size('EURUSD','BUY',1.2000,1.2000,mockConfig,goodStats,50); // SL = entry
    expect(volume).toBe(0);
  });

  test('NaN entry fails closed', () => {
    const { volume } = sizer.size('EURUSD','BUY',Number.NaN,1.1900,mockConfig,goodStats,50);
    expect(volume).toBe(0);
  });

  test('NaN quality score fails closed', () => {
    const { volume } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,goodStats,Number.NaN);
    expect(volume).toBe(0);
  });

  test('corrupt Kelly statistics fail closed', () => {
    const corrupt = {
      trades: 50,
      winRate: 0.6,
      avgWin: Number.NaN,
      avgLoss: 100,
    };
    const { volume } = sizer.size('EURUSD','BUY',1.2000,1.1900,mockConfig,corrupt,50);
    expect(volume).toBe(0);
  });
});
