/**
 * DATABASE MIGRATIONS — versioned, sequential, idempotent
 */
import Database from 'better-sqlite3';
import { Logger } from '../utils/Logger';

const logger = new Logger('Migrations');

interface Migration { version: number; name: string; up: string; }

const MIGRATIONS: Migration[] = [
  {
    version: 1, name: 'initial_schema',
    up: `
      CREATE TABLE IF NOT EXISTS trades (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket    INTEGER,
        symbol    TEXT    NOT NULL,
        timeframe TEXT,
        side      TEXT    NOT NULL,
        volume    REAL    NOT NULL,
        entry     REAL    NOT NULL,
        sl        REAL    NOT NULL,
        tp        REAL    NOT NULL,
        status    TEXT    NOT NULL DEFAULT 'open',
        openedAt  INTEGER NOT NULL,
        closedAt  INTEGER,
        profit    REAL,
        source    TEXT    NOT NULL DEFAULT '',
        account   TEXT    NOT NULL DEFAULT 'default',
        notes     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trades_status   ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol   ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_openedAt ON trades(openedAt);

      CREATE TABLE IF NOT EXISTS signals (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol     TEXT    NOT NULL,
        side       TEXT    NOT NULL,
        price      REAL    NOT NULL,
        confidence REAL    NOT NULL,
        sl         REAL,
        tp         REAL,
        source     TEXT    NOT NULL,
        reason     TEXT,
        timestamp  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(timestamp);

      CREATE TABLE IF NOT EXISTS daily_stats (
        day     TEXT PRIMARY KEY,
        trades  INTEGER NOT NULL DEFAULT 0,
        wins    INTEGER NOT NULL DEFAULT 0,
        losses  INTEGER NOT NULL DEFAULT 0,
        pnl     REAL    NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  { version: 2, name: 'add_commission', up: `ALTER TABLE trades ADD COLUMN commission REAL DEFAULT 0;` },
  { version: 3, name: 'add_exit_reason', up: `ALTER TABLE trades ADD COLUMN exitReason TEXT;` },
  { version: 4, name: 'add_decision_audit', up: `
    CREATE TABLE IF NOT EXISTS decision_audit (
      auditId    TEXT PRIMARY KEY,
      timestamp  INTEGER NOT NULL,
      symbol     TEXT    NOT NULL,
      side       TEXT    NOT NULL,
      decision   TEXT    NOT NULL,
      confidence REAL    NOT NULL,
      riskPassed INTEGER NOT NULL,
      blockedBy  TEXT    NOT NULL DEFAULT '',
      executedOk INTEGER,
      tradeId    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON decision_audit(timestamp);
  ` },
  { version: 5, name: 'add_news_cache', up: `
    CREATE TABLE IF NOT EXISTS news_cache (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol    TEXT NOT NULL,
      title     TEXT NOT NULL,
      impact    TEXT NOT NULL,
      eventTime INTEGER NOT NULL,
      fetchedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_news_symbol ON news_cache(symbol);
    CREATE INDEX IF NOT EXISTS idx_news_time   ON news_cache(eventTime);
  ` },
  { version: 6, name: 'add_account_snapshots', up: `
    CREATE TABLE IF NOT EXISTS account_snapshots (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      equity    REAL    NOT NULL,
      balance   REAL    NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON account_snapshots(timestamp);
  ` },
  {
    version: 7, name: 'strategy_metrics_table',
    up: `
      CREATE TABLE IF NOT EXISTS strategy_metrics (
        name               TEXT PRIMARY KEY,
        win_rate           REAL NOT NULL DEFAULT 0.5,
        sharpe_ratio       REAL NOT NULL DEFAULT 0,
        max_drawdown       REAL NOT NULL DEFAULT 0,
        expectancy         REAL NOT NULL DEFAULT 0,
        rolling_win_rate   REAL NOT NULL DEFAULT 0.5,
        rolling_expectancy REAL NOT NULL DEFAULT 0,
        total_trades       INTEGER NOT NULL DEFAULT 0,
        rolling_trades     INTEGER NOT NULL DEFAULT 0,
        updatedAt          INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS consensus_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol        TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        block_reason  TEXT NOT NULL,
        buy_weight    REAL,
        sell_weight   REAL,
        dominance     REAL,
        active_strats INTEGER,
        voters        INTEGER,
        duration_ms   INTEGER,
        reasoning     TEXT,
        timestamp     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_consensus_log_ts     ON consensus_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_consensus_log_symbol ON consensus_log(symbol);
      CREATE INDEX IF NOT EXISTS idx_strategy_metrics_name ON strategy_metrics(name);
    `,
  },
  {
    version: 8, name: 'performance_indexes',
    up: `
      CREATE INDEX IF NOT EXISTS idx_trades_source_status
        ON trades(source, status, openedAt);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_status_opened
        ON trades(symbol, status, openedAt);
    `,
  },
  { version: 9, name: 'add_realized_profit', up: `ALTER TABLE trades ADD COLUMN realizedProfit REAL NOT NULL DEFAULT 0;` },
  {
    version: 10, name: 'auditable_execution_and_ops_ledger',
    up: `
      CREATE TABLE IF NOT EXISTS execution_ledger (
        executionId   TEXT PRIMARY KEY,
        operationKey  TEXT NOT NULL UNIQUE,
        action        TEXT NOT NULL,
        status        TEXT NOT NULL,
        symbol        TEXT,
        side          TEXT,
        volume        REAL,
        signalId      TEXT,
        strategyId    TEXT,
        brokerOrderId TEXT,
        retryCount    INTEGER NOT NULL DEFAULT 0,
        requestJson   TEXT,
        resultJson    TEXT,
        error         TEXT,
        createdAt     INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_execution_ledger_status ON execution_ledger(status, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_execution_ledger_symbol ON execution_ledger(symbol, createdAt);

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        brokerOrderId TEXT,
        clientOrderId TEXT,
        executionId TEXT,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        type TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL,
        status TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orders_execution ON orders(executionId);
      CREATE INDEX IF NOT EXISTS idx_orders_symbol_status ON orders(symbol, status);

      CREATE TABLE IF NOT EXISTS executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        executionId TEXT NOT NULL UNIQUE,
        brokerOrderId TEXT,
        operationKey TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT,
        action TEXT NOT NULL,
        quantity REAL,
        price REAL,
        status TEXT NOT NULL,
        latencyMs INTEGER,
        retryCount INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_executions_ts ON executions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_executions_symbol ON executions(symbol, timestamp);

      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT 'default',
        side TEXT,
        quantity REAL NOT NULL,
        entryPrice REAL,
        brokerPositionId TEXT,
        status TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        UNIQUE(symbol, account)
      );

      CREATE TABLE IF NOT EXISTS protective_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        executionId TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        brokerOrderId TEXT,
        price REAL,
        quantity REAL,
        status TEXT NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_protective_execution ON protective_orders(executionId);

      CREATE TABLE IF NOT EXISTS risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        event TEXT NOT NULL,
        reason TEXT,
        severity TEXT NOT NULL,
        payload TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_risk_events_ts ON risk_events(timestamp);

      CREATE TABLE IF NOT EXISTS reconciliation_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        account TEXT,
        status TEXT NOT NULL,
        internalJson TEXT,
        brokerJson TEXT,
        reason TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recon_events_ts ON reconciliation_events(timestamp);

      CREATE TABLE IF NOT EXISTS model_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        modelName TEXT,
        modelVersion TEXT,
        promptVersion TEXT,
        inputHash TEXT,
        output TEXT,
        latencyMs INTEGER,
        decision TEXT,
        symbol TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_decisions_ts ON model_decisions(timestamp);

      CREATE TABLE IF NOT EXISTS system_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        severity TEXT NOT NULL,
        payload TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_system_events_ts ON system_events(timestamp);

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        severity TEXT NOT NULL,
        channel TEXT NOT NULL,
        event TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(timestamp);

      CREATE TABLE IF NOT EXISTS daily_metrics (
        day TEXT PRIMARY KEY,
        grossPnl REAL NOT NULL DEFAULT 0,
        netPnl REAL NOT NULL DEFAULT 0,
        fees REAL NOT NULL DEFAULT 0,
        slippage REAL NOT NULL DEFAULT 0,
        funding REAL NOT NULL DEFAULT 0,
        turnover REAL NOT NULL DEFAULT 0,
        trades INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equity REAL NOT NULL,
        balance REAL,
        drawdown REAL,
        portfolioHeat REAL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equity_snapshots_ts ON equity_snapshots(timestamp);
    `,
  },
    {
    version: 11, name: 'strategy_lifecycle_registry',
    up: `
      CREATE TABLE IF NOT EXISTS strategy_definitions (
        strategyId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        lifecycle TEXT NOT NULL,
        assetClassesJson TEXT NOT NULL,
        symbolsJson TEXT NOT NULL,
        timeframesJson TEXT NOT NULL,
        regimesJson TEXT NOT NULL,
        sessionsJson TEXT NOT NULL,
        requiredDataJson TEXT NOT NULL,
        parametersVersion TEXT NOT NULL,
        baseRiskFraction REAL NOT NULL,
        minimumRiskReward REAL NOT NULL,
        maximumDrawdown REAL NOT NULL,
        maximumCorrelatedExposure REAL,
        evidenceJson TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS strategy_lifecycle_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        strategyId TEXT NOT NULL,
        fromState TEXT NOT NULL,
        toState TEXT NOT NULL,
        at INTEGER NOT NULL,
        reason TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_strategy_lifecycle_strategy
        ON strategy_lifecycle_transitions(strategyId, at);
      CREATE INDEX IF NOT EXISTS idx_strategy_definitions_lifecycle
        ON strategy_definitions(lifecycle, enabled);
    `
  },  {
    version: 12, name: 'failure_memory',
    up: `
      CREATE TABLE IF NOT EXISTS failure_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tradeId INTEGER,
        symbol TEXT NOT NULL,
        timeframe TEXT,
        strategy TEXT,
        regime TEXT,
        side TEXT,
        entryPrice REAL,
        exitPrice REAL,
        spread REAL,
        slippage REAL,
        volatility REAL,
        newsContext TEXT,
        correlationContext TEXT,
        size REAL,
        profit REAL NOT NULL,
        rootCause TEXT NOT NULL,
        counterfactualJson TEXT,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_failure_memory_symbol_created
        ON failure_memory(symbol, createdAt);
      CREATE INDEX IF NOT EXISTS idx_failure_memory_strategy_created
        ON failure_memory(strategy, createdAt);
    `
  },

];

export function runMigrations(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL,
      name    TEXT    NOT NULL,
      appliedAt INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `).run();

  const applied = new Set<number>(
    (db.prepare('SELECT version FROM schema_version').all() as Array<{version: number}>)
      .map(r => r.version)
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    logger.info(`Applying migration v${m.version}: ${m.name}`);
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_version(version, name) VALUES (?, ?)').run(m.version, m.name);
    })();
    logger.info(`Migration v${m.version} applied`);
  }
}
