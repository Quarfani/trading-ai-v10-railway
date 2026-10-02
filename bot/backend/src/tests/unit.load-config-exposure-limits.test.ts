import { loadConfig } from "../utils/loadConfig";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const keys = [
    "DEPLOYMENT_PROFILE",
    "MODE",
    "DATA_SOURCE",
    "SYMBOLS",
    "TIMEFRAMES",
    "ACCOUNT_CURRENCY",
    "MAX_SYMBOL_EXPOSURE",
    "MAX_CORRELATED_EXPOSURE",
    "DASHBOARD_PASSWORD",
    "SESSION_SECRET",
  ];
  const previous = new Map<string, string | undefined>(
    keys.map(key => [key, process.env[key]]),
  );

  try {
    process.env.DEPLOYMENT_PROFILE = "local";
    process.env.MODE = "paper";
    process.env.DATA_SOURCE = "auto";
    process.env.SYMBOLS = "BTCUSDT,ETHUSDT";
    process.env.TIMEFRAMES = "M5,H1";
    process.env.ACCOUNT_CURRENCY = "USD";
    process.env.MAX_SYMBOL_EXPOSURE = "0.12";
    process.env.MAX_CORRELATED_EXPOSURE = "0.25";
    process.env.DASHBOARD_PASSWORD = "a-very-long-dashboard-password";
    process.env.SESSION_SECRET = "01234567890123456789012345678901";

    const configured = loadConfig();
    assert(configured.maxSymbolExposure === 0.12, "MAX_SYMBOL_EXPOSURE must be parsed into SystemConfig");
    assert(configured.maxCorrelatedExposure === 0.25, "MAX_CORRELATED_EXPOSURE must be parsed into SystemConfig");

    delete process.env.MAX_SYMBOL_EXPOSURE;
    delete process.env.MAX_CORRELATED_EXPOSURE;
    const defaults = loadConfig();
    assert(defaults.maxSymbolExposure === undefined, "omitted MAX_SYMBOL_EXPOSURE must remain undefined");
    assert(defaults.maxCorrelatedExposure === undefined, "omitted MAX_CORRELATED_EXPOSURE must remain undefined");

    console.log("Result: 2 passed, 0 failed");
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
