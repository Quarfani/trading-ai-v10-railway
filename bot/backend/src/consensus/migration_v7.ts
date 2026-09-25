// This file is appended to migrations.ts via the main migrations array
// Migration v7: strategy_metrics table for StrategyRegistry persistence

export const MIGRATION_V7 = {
  version: 7,
  name: 'strategy_metrics_table',
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
};
