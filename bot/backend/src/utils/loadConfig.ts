/**
 * CONFIG LOADER — with full validation
 * Throws on startup if any required value is missing or invalid.
 * This prevents silent misconfiguration in production.
 */
import 'dotenv/config';
import * as path from 'path';
import { SystemConfig, Mode, DataSource, Timeframe } from '../types/trading.types';
import { TIMEFRAMES, isTimeframe } from '../market/market.types';

const VALID_MODES:      Mode[]      = ['mt5', 'binance', 'paper'];
const VALID_DATA_SOURCES: DataSource[] = ['auto','mt5','binance'];
const VALID_DEPLOYMENT_PROFILES = ['local', 'railway-paper', 'cloud-paper', 'cloud-testnet', 'production'] as const;

function env(k: string, d = '')     { return process.env[k] ?? d; }
function num(k: string, d: number)  { const v = Number(process.env[k] ?? d); if (!Number.isFinite(v)) throw new Error(`[Config] ${k} must be numeric`); return v; }
function bool(k: string, d: boolean){ return (process.env[k] ?? String(d)) === 'true'; }

function requireEnv(k: string, ctx: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`[Config] Missing required env var: ${k} (needed for ${ctx})`);
  return v;
}

function validateRange(name: string, v: number, min: number, max: number): number {
  if (v < min || v > max) throw new Error(`[Config] ${name} must be between ${min} and ${max}, got ${v}`);
  return v;
}

export function loadConfig(): SystemConfig {
  const deploymentProfile = env('DEPLOYMENT_PROFILE', 'local');
  if (!VALID_DEPLOYMENT_PROFILES.includes(deploymentProfile as any)) {
    throw new Error(`[Config] DEPLOYMENT_PROFILE must be one of: ${VALID_DEPLOYMENT_PROFILES.join(', ')}`);
  }

  const mode = env('MODE', deploymentProfile === 'railway-paper' ? 'paper' : 'paper') as Mode;
  const dataSource = env('DATA_SOURCE', deploymentProfile === 'railway-paper' ? 'auto' : (mode === 'mt5' ? 'mt5' : mode === 'binance' ? 'binance' : 'auto')) as DataSource;
  if (!VALID_DATA_SOURCES.includes(dataSource)) throw new Error(`[Config] DATA_SOURCE must be one of ${VALID_DATA_SOURCES.join(', ')}`);

  if (!VALID_MODES.includes(mode)) {
    throw new Error(`[Config] MODE must be one of: ${VALID_MODES.join(', ')}. Got: "${mode}"`);
  }

  const rawTfs = env('TIMEFRAMES', 'M5,M15,H1')
    .split(',').map(s => s.trim()).filter(Boolean);

  for (const tf of rawTfs) {
    if (!isTimeframe(tf)) {
      throw new Error(`[Config] Invalid timeframe "${tf}". Valid: ${TIMEFRAMES.join(', ')}`);
    }
  }

  const tfs = rawTfs as Timeframe[];

  const symbols = env('SYMBOLS', deploymentProfile === 'railway-paper' ? 'BTCUSDT,ETHUSDT' : 'EURUSD,GBPUSD')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!symbols.length) throw new Error('[Config] SYMBOLS must contain at least one symbol');

  if (deploymentProfile === 'local') {
    if (mode !== 'paper') throw new Error('[Config] local profile only permits MODE=paper');
    if (process.env.ML_ENABLED === 'true' || process.env.ML_AUTO_TRAIN_ENABLED === 'true' || process.env.AUTO_WFO_ENABLED === 'true') {
      throw new Error('[Config] local 4GB profile forbids ML training/WFO; use cloud research resources');
    }
  }

  if (deploymentProfile === 'railway-paper') {
    if (mode !== 'paper') throw new Error('[Config] railway-paper profile only permits MODE=paper');
    if (dataSource !== 'binance' && dataSource !== 'auto') throw new Error('[Config] railway-paper profile requires DATA_SOURCE=binance or DATA_SOURCE=auto');
    if (dataSource === 'binance' && !symbols.every(s => /(USDT|USDC|BUSD)$/.test(s.toUpperCase().replace(/[^A-Z0-9]/g, '')))) {
      throw new Error('[Config] railway-paper profile with DATA_SOURCE=binance only supports Binance quote symbols (USDT/USDC/BUSD)');
    }
    if (process.env.ML_ENABLED === 'true') throw new Error('[Config] railway-paper keeps ML_ENABLED=false to protect the 1GB trial resource budget');
    if (process.env.ML_AUTO_TRAIN_ENABLED === 'true') throw new Error('[Config] railway-paper forbids automatic ML training');
    if (process.env.AUTO_WFO_ENABLED === 'true') throw new Error('[Config] railway-paper forbids automatic WFO parameter mutation');
    if (process.env.S3_BACKUP_ENABLED === 'true') throw new Error('[Config] railway-paper disables the unfinished S3-compatible backup path; use local volume backups');
  }

  const riskPerTrade = validateRange('RISK_PER_TRADE', num('RISK_PER_TRADE', 0.01), 0.001, 0.02);
  const maxDailyLoss = validateRange('MAX_DAILY_LOSS',  num('MAX_DAILY_LOSS', 0.02),  0.005, 0.25);
  const maxWeeklyLoss = validateRange('MAX_WEEKLY_LOSS', num('MAX_WEEKLY_LOSS', 0.05), 0.01, 0.50);
  const maxDrawdown = validateRange('MAX_DRAWDOWN', num('MAX_DRAWDOWN', 0.10), 0.01, 0.50);
  const maxPortfolioHeat = validateRange('MAX_PORTFOLIO_HEAT', num('MAX_PORTFOLIO_HEAT', 0.06), 0.005, 0.50);
  const maxLeverage = validateRange('MAX_LEVERAGE', num('MAX_LEVERAGE', 3), 1, 50);
  const maxExposure = validateRange('MAX_EXPOSURE', num('MAX_EXPOSURE', 1), 0.05, 10);
  const minConfidence = validateRange('MIN_CONFIDENCE', num('MIN_CONFIDENCE', 0.55),  0.3,  0.99);
  const mlRequired = bool('ML_REQUIRED', false);
  const maxSlippagePips = validateRange('MAX_SLIPPAGE_PIPS', num('MAX_SLIPPAGE_PIPS', 3), 0, 1000);
  const minRR = validateRange('MIN_RR', num('MIN_RR', 1.5), 0.5, 20);
  const consecutiveLossLimit = validateRange('CONSECUTIVE_LOSS_LIMIT', num('CONSECUTIVE_LOSS_LIMIT', 3), 1, 100);
  const cooldownMinutes = validateRange('COOLDOWN_MINUTES', num('COOLDOWN_MINUTES', 60), 0, 24 * 60);
  const s3Enabled = bool('S3_BACKUP_ENABLED', false);

  // Mode-specific required vars
  const mt5Server=env('MT5_SERVER_NAME',env('MT5_SERVER'));
  const hasMt5Symbols = symbols.some(s => !/(USDT|USDC|BUSD)$/.test(s.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  if (mode === 'mt5' || (mode === 'paper' && (dataSource === 'mt5' || (dataSource === 'auto' && hasMt5Symbols)))) {
    if (!num('MT5_LOGIN', 0)) throw new Error('[Config] MT5_LOGIN required for MT5-backed mode');
    requireEnv('MT5_PASSWORD','MT5-backed mode');
    requireEnv('MT5_BRIDGE_API_KEY','MT5-backed mode');
    if(!mt5Server) throw new Error('[Config] MT5_SERVER_NAME (or legacy MT5_SERVER) required for MT5-backed mode');
  }
  if (mode === 'binance') {
    requireEnv('BINANCE_API_KEY', 'binance mode');
    requireEnv('BINANCE_SECRET',  'binance mode');
  }
  const binanceEnv = env('BINANCE_ENV', 'testnet');
  if (!['testnet','mainnet'].includes(binanceEnv)) throw new Error('[Config] BINANCE_ENV must be testnet or mainnet');
  const liveTradingAck = env('LIVE_TRADING_ACK', '');
  if (mode !== 'paper' && binanceEnv === 'mainnet' && liveTradingAck !== 'I_UNDERSTAND_LIVE_RISK')
    throw new Error('[Config] Mainnet live trading requires LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_RISK');
  const maxOpenTrades = validateRange('MAX_OPEN_TRADES', num('MAX_OPEN_TRADES', 5), 1, 100);
  if (!Number.isInteger(maxOpenTrades)) throw new Error('[Config] MAX_OPEN_TRADES must be an integer');
  const accountBalance = validateRange('ACCOUNT_BALANCE', num('ACCOUNT_BALANCE', 10000), 0.01, 1_000_000_000);
  const dailyProfitTarget = validateRange('DAILY_PROFIT_TARGET', num('DAILY_PROFIT_TARGET', 0.03), 0, 1);
  const reinvestRate = validateRange('COMPOUNDING_REINVEST_RATE', num('COMPOUNDING_REINVEST_RATE', 0.8), 0, 1);
  const dashPw = env('DASHBOARD_PASSWORD', '');
  if (dashPw.length < 12) throw new Error('[Config] DASHBOARD_PASSWORD must be set and at least 12 characters');
  const sessionSecret = env('SESSION_SECRET', '');
  if (sessionSecret.length < 32) throw new Error('[Config] SESSION_SECRET must be set and at least 32 characters');
  const operatorPassword = env('OPERATOR_PASSWORD', '');
  if (mode !== 'paper') {
    if (operatorPassword.length < 12) throw new Error('[Config] OPERATOR_PASSWORD must be set and at least 12 characters in non-paper modes');
    if (operatorPassword === dashPw) throw new Error('[Config] OPERATOR_PASSWORD must differ from DASHBOARD_PASSWORD');
  }
  if (s3Enabled) {
    for (const k of ['S3_ENDPOINT','S3_BUCKET','S3_ACCESS_KEY','S3_SECRET_KEY','S3_ENCRYPTION_KEY']) requireEnv(k, 'S3 backup');
  }

  return {
    mode,
    dataSource,
    accountBalance,
    riskPerTrade,
    maxOpenTrades,
    minConfidence,
    maxDailyLoss,
    maxWeeklyLoss,
    dailyProfitTarget,
    consecutiveLossLimit,
    cooldownMinutes,
    symbols,
    timeframes: tfs,
    scanInterval:         Math.max(deploymentProfile === 'railway-paper' ? 30_000 : 5_000, num('SCAN_INTERVAL', deploymentProfile === 'railway-paper' ? 30_000 : 15_000)),
    dbPath:               path.resolve(env('DB_PATH', deploymentProfile === 'railway-paper' ? '/app/data/trading.db' : './data/trading.db')),

    mt5: {
      login:     num('MT5_LOGIN', 0),
      password:  env('MT5_PASSWORD'),
      server:    mt5Server,
      bridgeUrl: env('MT5_BRIDGE_URL', 'http://127.0.0.1:5000'),
      bridgeApiKey: env('MT5_BRIDGE_API_KEY'),
    },
    binance: {
      apiKey: env('BINANCE_API_KEY'),
      secret: env('BINANCE_SECRET'),
      env:    binanceEnv as 'testnet' | 'mainnet',
      futures: bool('BINANCE_FUTURES', true),
    },
    telegram: {
      token:  env('TELEGRAM_TOKEN'),
      chatId: env('TELEGRAM_CHAT_ID'),
    },
    nvidia: {
      apiKey:  env('NVIDIA_API_KEY'),
      baseUrl: env('NVIDIA_BASE_URL', 'https://integrate.api.nvidia.com/v1'),
      model:   env('NVIDIA_MODEL', 'meta/llama-3.1-8b-instruct'),
    },
    graduation: {
      minTrades:         num('MIN_TRADES_TO_GRADUATE', 20),
      winrateThreshold:  num('WINRATE_THRESHOLD', 0.65),
      binanceCapital:    num('BINANCE_CAPITAL', 20),
    },
    compounding: {
      enabled:      bool('COMPOUNDING_ENABLED', true),
      reinvestRate,
    },
    maxPortfolioHeat,
    maxDrawdown,
    maxLeverage,
    maxExposure,
    mlRequired,
    minRR,
    maxSlippagePips,
    accountName:       env('ACCOUNT_NAME', 'default'),
    newsFilter: {
      enabled:           bool('NEWS_FILTER_ENABLED', true),
      blockMediumImpact: bool('NEWS_BLOCK_MEDIUM_IMPACT', false),
    },
    consensus: {
      minimumTotalWeight:      num('CONSENSUS_MIN_WEIGHT', 0.25),
      dominanceRatio:          num('CONSENSUS_DOMINANCE', 0.60),
      minimumActiveStrategies: num('CONSENSUS_MIN_STRATEGIES', 1),
      rollingWindowSize:       num('CONSENSUS_ROLLING_WINDOW', 30),
      gate: {
        minWinRate:           num('CONSENSUS_GATE_MIN_WIN_RATE', 0.48),
        minSharpeRatio:       num('CONSENSUS_GATE_MIN_SHARPE', 0.80),
        minRollingExpectancy: 0.00,
        maxDrawdown:          0.22,
        minTradesForGate:     num('CONSENSUS_GATE_MIN_TRADES', 20),
      },
    },
    s3Backup: s3Enabled ? {
      enabled:       true,
      endpoint:      env('S3_ENDPOINT'),
      bucket:        env('S3_BUCKET'),
      accessKey:     env('S3_ACCESS_KEY'),
      secretKey:     env('S3_SECRET_KEY'),
      region:        env('S3_REGION', 'us-east-1'),
      encryptionKey: env('S3_ENCRYPTION_KEY'),
    } : undefined,
  };
}
