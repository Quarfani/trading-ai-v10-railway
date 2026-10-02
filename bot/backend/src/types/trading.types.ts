/**
 * TRADING TYPES — v7.1
 * [NEW] StrategyPerformance — for dashboard API
 * [NEW] MarketRegime in Signal
 * [FIX] Trade: added timeframe field missing from interface
 * [NEW] SystemConfig: added minRR, maxSlippage, newsFilter fields
 *
 * Timeframe is now sourced from the canonical market domain.
 */
import { Timeframe } from '../market/market.types';

export type { Timeframe } from '../market/market.types';

export type Side         = 'BUY' | 'SELL';
export type Mode         = 'mt5' | 'binance' | 'paper';
export type DataSource   = 'auto' | 'mt5' | 'binance';
export type DecisionType = 'BUY' | 'SELL' | 'NO_TRADE';

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

export interface Signal {
  symbol: string;
  side: Side;
  price: number;
  confidence: number;
  sl: number;
  tp: number;
  source: string;
  reason: string;
  timestamp: number;
  regime?: string;
  exitPrice?: number;
  timeframe?: Timeframe;
  quality?: number;
  /** Stable identifier linking this signal to its ML prediction audit record. */
  mlPredictionId?: string;
}

export interface RiskResult {
  passed: boolean;
  volume: number;
  blockedBy: string;
  reasons: string[];
}

export interface TradeDecision {
  decision: DecisionType;
  confidence: number;
  volume: number;
  reasons: string[];
  auditId: string;
}

export interface DecisionAudit {
  auditId: string;
  timestamp: number;
  symbol: string;
  side: Side;
  decision: DecisionType;
  confidence: number;
  riskPassed: boolean;
  blockedBy: string;
  executedOk?: boolean;
  tradeId?: number;
}

export interface Trade {
  id?: number;
  ticket?: number;
  symbol: string;
  timeframe?: Timeframe;
  side: Side;
  volume: number;
  entry: number;
  sl: number;
  tp: number;
  status: 'open' | 'closed';
  openedAt: number;
  closedAt?: number;
  profit?: number;
  realizedProfit?: number;
  source: string;
  exitReason?: string;
  commission?: number;
  entryQuoteToAccount?: number;
  exitQuoteToAccount?: number;
  notes?: string;
  account?: string;
  /** ML prediction identifier used to create this trade, when applicable. */
  mlPredictionId?: string;
}

export interface StrategyPerformance {
  name: string;
  enabled: boolean;
  totalTrades: number;
  winRate: number;
  sharpeRatio: number;
  rollingWinRate: number;
  expectancy: number;
  maxDrawdown: number;
  disabledReason?: string;
}

export interface SystemConfig {
  accountName?: string;
  accountCurrency?: string;
  evidencePromotion?: {
    minSampleSize: number;
    minOutOfSampleTrades: number;
    minOutOfSampleProfitFactor: number;
    minWalkForwardStability: number;
    minParameterSensitivity: number;
    minRegimeCoverage: number;
    maxAgeMs: number;
    requireMonteCarlo: boolean;
    maxMonteCarloDD95: number;
    maxMonteCarloRuinProbability: number;
    maxMonteCarloUnrecoveredRate: number;
  };
  mode: Mode;
  accountBalance: number;
  dataSource: DataSource;

  riskPerTrade: number;
  maxPortfolioHeat?: number;
  maxOpenTrades: number;
  minConfidence: number;
  maxDailyLoss: number;
  maxWeeklyLoss?: number;
  dailyProfitTarget: number;
  consecutiveLossLimit: number;
  cooldownMinutes: number;
  minRR?: number;
  maxSlippagePips?: number;
  /** Optional asset-agnostic maximum fill slippage as a fraction. */
  maxSlippagePct?: number;
  maxDrawdown?: number;
  maxLeverage?: number;
  maxExposure?: number;
  mlRequired: boolean;

  symbols: string[];
  timeframes: Timeframe[];
  scanInterval: number;
  dbPath: string;

  mt5: {
    login: number;
    password: string;
    server: string;
    bridgeUrl: string;
    bridgeApiKey: string;
  };

  binance: {
    apiKey: string;
    secret: string;
    env: 'testnet' | 'mainnet';
    futures: boolean;
  };

  telegram: { token: string; chatId: string; };

  consensus?: {
    minimumTotalWeight: number;
    dominanceRatio: number;
    minimumActiveStrategies: number;
    rollingWindowSize: number;
    gate?: {
      minWinRate: number;
      minSharpeRatio: number;
      minRollingExpectancy: number;
      maxDrawdown: number;
      minTradesForGate: number;
    };
  };

  s3Backup?: {
    enabled: boolean;
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    region: string;
    encryptionKey?: string;
  };

  newsFilter?: {
    enabled: boolean;
    blockMediumImpact: boolean;
  };

  enhancements?: {
    regimeDetection: boolean;
    kellysizing: boolean;
    qualityScoring: boolean;
    sessionFilter: boolean;
    drawdownScaling: boolean;
  };

  compounding: { enabled: boolean; reinvestRate: number; };
  graduation?: {
    minTrades: number;
    winrateThreshold: number;
    binanceCapital: number;
  };
  nvidia?: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
}
