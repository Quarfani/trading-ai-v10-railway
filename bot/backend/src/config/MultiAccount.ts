/**
 * Multi-account loader — define additional accounts via .env:
 *   ACCOUNTS=demo,live
 *   ACC_demo_MODE=mt5
 *   ACC_demo_MT5_LOGIN=12345
 *   ACC_demo_MT5_PASSWORD=...
 *   ACC_demo_MT5_SERVER_NAME=...
 *   ACC_demo_RISK_PER_TRADE=0.01
 *
 *   ACC_live_MODE=binance
 *   ACC_live_BINANCE_API_KEY=...
 *   ACC_live_BINANCE_SECRET=...
 *   ACC_live_RISK_PER_TRADE=0.005
 *
 * If ACCOUNTS is empty, the bot runs the default single-account config.
 */
import { SystemConfig } from '../types/trading.types';
import { loadConfig } from '../utils/loadConfig';

export interface AccountConfig extends SystemConfig {
  accountName: string;
}

export function loadAccounts(): AccountConfig[] {
  const list = (process.env.ACCOUNTS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return [{ ...loadConfig(), accountName: 'default' }];
  const base = loadConfig();
  return list.map(name => {
    const get = (k: string, d: string) => process.env[`ACC_${name}_${k}`] ?? d;
    const num = (k: string, d: number) => Number(process.env[`ACC_${name}_${k}`] ?? d);
    return {
      ...base,
      accountName: name,
      mode: (get('MODE', base.mode) as any),
      riskPerTrade: num('RISK_PER_TRADE', base.riskPerTrade),
      maxOpenTrades: num('MAX_OPEN_TRADES', base.maxOpenTrades),
      mt5: {
        login: num('MT5_LOGIN', base.mt5.login),
        password: get('MT5_PASSWORD', base.mt5.password),
        server: get('MT5_SERVER_NAME', base.mt5.server),
        bridgeUrl: get('MT5_BRIDGE_URL', base.mt5.bridgeUrl),
        bridgeApiKey: get('MT5_BRIDGE_API_KEY', base.mt5.bridgeApiKey),
      },
      binance: {
        apiKey: get('BINANCE_API_KEY', base.binance.apiKey),
        secret: get('BINANCE_SECRET', base.binance.secret),
        env: (get('BINANCE_ENV', base.binance.env) as 'testnet' | 'mainnet'),
        futures: String(process.env[`ACC_${name}_BINANCE_FUTURES`] ?? base.binance.futures).toLowerCase() === 'true',
      },
    };
  });
}
