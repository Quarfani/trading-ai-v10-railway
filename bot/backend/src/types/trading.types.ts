/**
 * TRADING TYPES — v7.1
 * [NEW] StrategyPerformance — for dashboard API
 * [NEW] MarketRegime in Signal
 * [FIX] Trade: added timeframe field missing from interface
 * [NEW] SystemConfig: added minRR, maxSlippage, newsFilter fields
 */

// ─── Primitives ───────────────────────────────────────────────────────────────

export type Side         = 'BUY' | 'SELL';
export type Mode         = 'mt5' | 'binance' | 'paper';
export type DataSource   = 'auto' | 'mt5' | 'binance';
import { Timeframe } from '../market/market.types';
export type { Timeframe } from '../market/market.types';
export type DecisionType = 'BUY' | 'SELL' | 'NO_TRADE';

// ─── Market data ──────────────────────────────────────────────────────────────

export interface Candle {
  time: number; open: number; high: number; low: number;
  close: number; volume: number;
  source?: string;
  quality?: 'good' | 'imputed' | 'synthetic' | 'invalid';
  is_imputed?: boolean;
  is_synthetic?: boolean;
  latency?: number;
  sequence_valid?: boolean;
}

// ─── Signal ────────────────────────────────────────────────────────────────────

export interface Signal {
  symbol:     string;
  side:       Side;
  price:      number;
  confidence: number;
  sl:         number;
  tp:         number;
  source:     string;
  reason:     string;
  timestamp:  number;
  regime?:    string;
  exitPrice?: number;
  timeframe?: Timeframe;
  quality?:   number;
}

// ─── Risk ──────────────────────────────────────────────────────────────────────

export interface RiskResult {
  passed:    boolean;
  volume:    number;
  blockedBy: string;
  reasons:   string[];
}

// ─── Trade Decision ────────────────────────────────────────────────────────────

export interface TradeDecision {
  decision:   DecisionType;
  confidence: number;
  volume:     number;
  reasons:    string[];
  auditId:    string;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export interface DecisionAudit {
  auditId:     string;
  timestamp:   number;
  symbol:      string;
  side:        Side;
  decision:    DecisionType;
  confidence:  number;
  riskPassed:  boolean;
  blockedBy:   string;
  executedOk?: boolean;
  tradeId?:    number;
}

// ─── Trade (DB row) ───────────────────────────────────────────────────────────

export interface Trade {
  id?:         number;
  ticket?:     number;
  symbol:      string;
  timeframe?:  Timeframe;   // canonical timeframe contract
  side:        Side;
  volume:      number;
  entry:       number;
  sl:          number;
  tp:          number;
  status:      'open' | 'closed';
  openedAt:    number;
  closedAt?:   number;
  profit?:     number;
  realizedProfit?: number;
  source:      string;
  exitReason?: string;
  commission?: number;
  notes?:      string;
  account?:    string;
}

// ─── Strategy Performance (for API / dashboard) ───────────────────────────────

export interface StrategyPerformance {
  name:              string;
  enabled:           boolean;
  totalTrades:       number;
  winRate:           number;
  sharpeRatio:       number;
  rollingWinRate:    number;
  expectancy:        number;
  maxDrawdown:       number;
  disabledReason?:   string;
}

// ─── System Config ─────────────────────────────────────────────────────────────

export interface SystemConfig {
  accountName?: string;
  mode:           Mode;
  accountBalance: number;
  dataSource: DataSource;

  // Risk
  riskPerTrade:         number;
  maxPortfolioHeat?:    number;
  maxOpenTrades:        number;
  minConfidence:        number;
  maxDailyLoss:         number;
  maxWeeklyLoss?:       number;
  dailyProfitTarget:    number;
  consecutiveLossLimit: number;
  cooldownMinutes:      number;
  minRR?:               number;   // [NEW] Minimum R:R ratio (default 1.5)
  maxSlippagePips?:     number;   // [NEW] Max acceptable slippage in pips
  maxDrawdown?:         number;   // absolute portfolio drawdown guard
  maxLeverage?:         number;
  maxExposure?:         number;
  mlRequired:           boolean;

  // Trading universe
  symbols:      string[];
  timeframes:   Timeframe[];
  scanInterval: number;
  dbPath:       string;

  // Brokers
  mt5:     { login: number; password: string; server: string; bridgeUrl: string; bridgeApiKey: string; };
  binance: { apiKey: string; secret: string; env: 'testnet' | 'mainnet'; futures: boolean; };
  telegram: { token: string; chatId: string; };

  // Consensus
  consensus?: {
    minimumTotalWeight:      number;
    dominanceRatio:          number;
    minimumActiveStrategies: number;
    rollingWindowSize:       number;
    gate?: {
      minWinRate:           number;
      minSharpeRatio:       number;
      minRollingExpectancy: number;
      maxDrawdown:          number;
      minTradesForGate:     number;
    };
  };

  // S3 Backup
  s3Backup?: {
    enabled:        boolean;
    endpoint:       string;
    bucket:         string;
    accessKey:      string;
    secretKey:      string;
    region:         string;
    encryptionKey?: string;
  };

  // News filter [NEW]
  newsFilter?: {
    enabled:            boolean;
    blockMediumImpact:  boolean;
  };

  // Enhancements
  enhancements?: {
    regimeDetection:  boolean;
    kellysizing:      boolean;
    qualityScoring:   boolean;
    sessionFilter:    boolean;
    drawdownScaling:  boolean;
  };

  // Optional features
  compounding: { enabled: boolean; reinvestRate: number; };
  graduation?: { minTrades: number; winrateThreshold: number; binanceCapital: number; };
  nvidia?: { apiKey: string; baseUrl: string; model: string; };
}
