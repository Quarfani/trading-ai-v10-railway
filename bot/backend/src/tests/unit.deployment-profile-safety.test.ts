import { loadConfig } from '../utils/loadConfig';

const KEYS = [
  'ACCOUNT_BALANCE', 'ACCOUNT_CURRENCY', 'ACCOUNT_NAME', 'AUTO_WFO_ENABLED',
  'BINANCE_API_KEY', 'BINANCE_CAPITAL', 'BINANCE_ENV', 'BINANCE_FUTURES', 'BINANCE_SECRET',
  'COMPOUNDING_ENABLED', 'COMPOUNDING_REINVEST_RATE', 'CONSECUTIVE_LOSS_LIMIT', 'CONSENSUS_DOMINANCE',
  'CONSENSUS_GATE_MIN_SHARPE', 'CONSENSUS_GATE_MIN_TRADES', 'CONSENSUS_GATE_MIN_WIN_RATE',
  'CONSENSUS_MIN_STRATEGIES', 'CONSENSUS_MIN_WEIGHT', 'CONSENSUS_ROLLING_WINDOW', 'COOLDOWN_MINUTES',
  'DAILY_PROFIT_TARGET', 'DASHBOARD_PASSWORD', 'DATA_SOURCE', 'DB_PATH', 'DEPLOYMENT_PROFILE',
  'EVIDENCE_MAX_AGE_DAYS', 'EVIDENCE_MAX_MC_DD95', 'EVIDENCE_MAX_MC_RUIN', 'EVIDENCE_MAX_MC_UNRECOVERED',
  'EVIDENCE_MIN_OOS_PF', 'EVIDENCE_MIN_OOS_TRADES', 'EVIDENCE_MIN_PARAMETER_SENSITIVITY',
  'EVIDENCE_MIN_REGIME_COVERAGE', 'EVIDENCE_MIN_SAMPLE_SIZE', 'EVIDENCE_MIN_WFO_STABILITY',
  'EVIDENCE_REQUIRE_MONTE_CARLO', 'LIVE_TRADING_ACK', 'MAX_DAILY_LOSS', 'MAX_DRAWDOWN',
  'MAX_EXPOSURE', 'MAX_LEVERAGE', 'MAX_OPEN_TRADES', 'MAX_PORTFOLIO_HEAT', 'MAX_SLIPPAGE_PCT',
  'MAX_SLIPPAGE_PIPS', 'MAX_WEEKLY_LOSS', 'MIN_CONFIDENCE', 'MIN_RR', 'MIN_TRADES_TO_GRADUATE',
  'ML_AUTO_TRAIN_ENABLED', 'ML_ENABLED', 'ML_REQUIRED', 'MODE', 'MT5_BRIDGE_API_KEY',
  'MT5_BRIDGE_URL', 'MT5_LIVE_TRADING_ACK', 'MT5_LOGIN', 'MT5_PASSWORD', 'MT5_SERVER',
  'MT5_SERVER_NAME', 'NEWS_BLOCK_MEDIUM_IMPACT', 'NEWS_FILTER_ENABLED', 'NVIDIA_API_KEY',
  'NVIDIA_BASE_URL', 'NVIDIA_MODEL', 'OPERATOR_PASSWORD', 'RISK_PER_TRADE', 'S3_ACCESS_KEY',
  'S3_BACKUP_ENABLED', 'S3_BUCKET', 'S3_ENCRYPTION_KEY', 'S3_ENDPOINT', 'S3_REGION',
  'S3_SECRET_KEY', 'SCAN_INTERVAL', 'SESSION_SECRET', 'SYMBOLS', 'TELEGRAM_CHAT_ID',
  'TELEGRAM_TOKEN', 'TIMEFRAMES', 'WINRATE_THRESHOLD',
] as const;

const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
let passed = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  passed += 1;
}

function restoreEnvironment(): void {
  for (const key of KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setBase(overrides: Record<string, string> = {}): void {
  for (const key of KEYS) delete process.env[key];
  const values: Record<string, string> = {
    DEPLOYMENT_PROFILE: 'cloud-testnet',
    MODE: 'binance',
    DATA_SOURCE: 'binance',
    SYMBOLS: 'BTCUSDT,ETHUSDT',
    TIMEFRAMES: 'H1',
    DASHBOARD_PASSWORD: 'test-dashboard-password-001',
    SESSION_SECRET: 'test-session-secret-value-which-is-long-enough-0001',
    OPERATOR_PASSWORD: 'test-operator-password-002',
    BINANCE_API_KEY: 'testnet-key-placeholder',
    BINANCE_SECRET: 'testnet-secret-placeholder',
    BINANCE_ENV: 'testnet',
    LIVE_TRADING_ACK: '',
    MT5_LIVE_TRADING_ACK: '',
    MT5_LOGIN: '1',
    MT5_PASSWORD: 'mt5-password-placeholder',
    MT5_BRIDGE_API_KEY: 'mt5-bridge-key-placeholder',
    MT5_SERVER_NAME: 'test-server',
    MT5_BRIDGE_URL: 'http://127.0.0.1:5000',
    ML_ENABLED: 'false',
    ML_AUTO_TRAIN_ENABLED: 'false',
    AUTO_WFO_ENABLED: 'false',
    S3_BACKUP_ENABLED: 'false',
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

function expectRejected(overrides: Record<string, string>, fragment: string, message: string): void {
  setBase(overrides);
  let rejected = false;
  try {
    loadConfig();
  } catch (error) {
    rejected = String(error).includes(fragment);
  }
  assert(rejected, message);
}

function main(): void {
  try {
    expectRejected(
      { DEPLOYMENT_PROFILE: 'railway-paper', DATA_SOURCE: 'auto' },
      'requires DATA_SOURCE=binance',
      'Railway paper must reject auto mode because it could select MT5',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'railway-paper', SYMBOLS: 'EURUSD' },
      'only supports Binance quote symbols',
      'Railway paper must reject non-Binance symbols',
    );

    setBase({ DEPLOYMENT_PROFILE: 'railway-paper', MODE: 'paper', BINANCE_ENV: 'mainnet', BINANCE_API_KEY: '', BINANCE_SECRET: '' });
    const railwayPaper = loadConfig();
    assert(
      railwayPaper.mode === 'paper' &&
      railwayPaper.dataSource === 'binance' &&
      railwayPaper.binance.apiKey === '' && railwayPaper.binance.secret === '',
      'valid Railway paper profile must remain paper-only with no Binance credentials required',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'cloud-testnet', MODE: 'paper' },
      'requires MODE=binance',
      'Cloud Testnet must reject paper mode under a Testnet deployment profile',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'cloud-testnet', BINANCE_ENV: 'mainnet', LIVE_TRADING_ACK: 'I_UNDERSTAND_LIVE_RISK' },
      'requires BINANCE_ENV=testnet',
      'Cloud Testnet must reject Binance mainnet even if a live acknowledgment is present',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'cloud-testnet', DATA_SOURCE: 'mt5' },
      'requires DATA_SOURCE=binance',
      'Cloud Testnet must require Binance market/execution symbols',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'production', MODE: 'binance', DATA_SOURCE: 'mt5', BINANCE_ENV: 'mainnet', LIVE_TRADING_ACK: 'I_UNDERSTAND_LIVE_RISK' },
      'MODE=binance requires DATA_SOURCE=binance',
      'Binance execution must reject MT5 market data configuration',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'production', MODE: 'mt5', DATA_SOURCE: 'binance', MT5_LIVE_TRADING_ACK: 'I_UNDERSTAND_MT5_LIVE_RISK' },
      'MODE=mt5 requires DATA_SOURCE=mt5',
      'MT5 execution must reject Binance market data configuration',
    );

    setBase({ DEPLOYMENT_PROFILE: 'cloud-testnet', MODE: 'binance', BINANCE_ENV: 'testnet' });
    const testnet = loadConfig();
    assert(
      testnet.mode === 'binance' && testnet.binance.env === 'testnet',
      'valid Cloud Testnet profile must resolve to Binance Testnet',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'production', MODE: 'paper' },
      'requires a non-paper broker mode',
      'Production profile must not silently start in paper mode',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'production', MODE: 'binance', BINANCE_ENV: 'testnet' },
      'requires BINANCE_ENV=mainnet',
      'Production Binance profile must reject Testnet endpoints',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'production', MODE: 'binance', BINANCE_ENV: 'mainnet', LIVE_TRADING_ACK: '' },
      'LIVE_TRADING_ACK=I_UNDERSTAND_LIVE_RISK',
      'Binance mainnet must require the explicit live trading acknowledgment',
    );

    setBase({
      DEPLOYMENT_PROFILE: 'production',
      MODE: 'binance',
      BINANCE_ENV: 'mainnet',
      LIVE_TRADING_ACK: 'I_UNDERSTAND_LIVE_RISK',
    });
    const productionBinance = loadConfig();
    assert(
      productionBinance.mode === 'binance' && productionBinance.binance.env === 'mainnet',
      'production Binance profile should load only with explicit mainnet acknowledgment',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'production', MODE: 'mt5', DATA_SOURCE: 'mt5', MT5_LIVE_TRADING_ACK: '' },
      'MT5_LIVE_TRADING_ACK=I_UNDERSTAND_MT5_LIVE_RISK',
      'MT5 execution must require its own explicit live acknowledgment',
    );

    setBase({
      DEPLOYMENT_PROFILE: 'production',
      MODE: 'mt5',
      DATA_SOURCE: 'mt5',
      SYMBOLS: 'EURUSD',
      MT5_LIVE_TRADING_ACK: 'I_UNDERSTAND_MT5_LIVE_RISK',
    });
    const productionMt5 = loadConfig();
    assert(
      productionMt5.mode === 'mt5',
      'production MT5 profile should load only with explicit MT5 acknowledgment',
    );

    expectRejected(
      { DEPLOYMENT_PROFILE: 'cloud-paper', MODE: 'binance' },
      'only permits MODE=paper',
      'Cloud paper must reject live broker mode',
    );
  } finally {
    restoreEnvironment();
  }

  console.log(`Result: ${passed} passed, 0 failed`);
}

main();
