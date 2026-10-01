/**
 * HEALTH MONITOR — ENHANCED
 * [NEW] يراقب: MT5 + DB + Memory + CPU + Open trades anomaly
 * [NEW] Auto-triggers EmergencyStop إذا صارت مشاكل متعددة في نفس الوقت
 * [NEW] Memory leak detection — يُنبّه إذا تجاوز الـ heap 500MB
 */
import axios            from 'axios';
import { SystemConfig } from '../types/trading.types';
import { DatabaseManager }  from '../database/DatabaseManager';
import { TelegramBot }      from '../notifications/TelegramBot';
import { EmergencyStop }    from './EmergencyStop';
import { Logger }           from '../utils/Logger';
import { getBrokerContractStatus } from '../market/MarketCatalog';

export interface HealthStatus {
  ok:           boolean;
  mt5:          boolean;
  binance:      boolean;
  contractsReady: boolean;
  db:           boolean;
  memoryMB:     number;
  memoryOk:     boolean;
  uptime:       number;
  openTrades:   number;
  checkedAt:    number;
  issues:       string[];
}

const MAX_MEMORY_MB   = 500;
const MAX_OPEN_TRADES = 20; // anomaly threshold — more than this is suspicious

export class HealthMonitor {
  private logger    = new Logger('HealthMonitor');
  private interval: NodeJS.Timeout | null = null;
  private startedAt = Date.now();

  private status: HealthStatus = {
    ok: true, mt5: true, binance: true, contractsReady: true, db: true, memoryMB: 0, memoryOk: true,
    uptime: 0, openTrades: 0, checkedAt: Date.now(), issues: [],
  };

  private alertedMT5    = false;
  private alertedMemory = false;
  private failStreak    = 0; // consecutive full-health-fail cycles

  constructor(
    private config:    SystemConfig,
    private db:        DatabaseManager,
    private telegram:  TelegramBot,
    private emergency: EmergencyStop,
  ) {}

  start() {
    if (!this.interval) {
      this.tick().catch(() => {});
      this.interval = setInterval(() => this.tick().catch(() => {}), 60_000);
    }
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  getStatus(): HealthStatus { return { ...this.status }; }

  private async tick() {
    const issues: string[] = [];

    // ── MT5 ──────────────────────────────────────────────────────────────
    const needed=this.resolveSources();
    const mt5Ok=needed.has('mt5')?await this.checkMT5():true;
    const binanceOk=needed.has('binance')?await this.checkBinance():true;
    const contractStatus = this.config.mode === 'mt5'
      ? getBrokerContractStatus(this.config.symbols)
      : { ready: true };
    const contractsReady = Boolean(contractStatus.ready);
    if (!mt5Ok) {
      issues.push('MT5 bridge unreachable');
      if (!this.alertedMT5) {
        this.alertedMT5 = true;
        await this.telegram.sendMessage('⚠️ <b>MT5 bridge unreachable</b> — check VPS').catch(() => {});
      }
    } else if (this.alertedMT5) {
      this.alertedMT5 = false;
      await this.telegram.sendMessage('✅ <b>MT5 bridge reconnected</b>').catch(() => {});
    }

    if(!binanceOk) issues.push('Binance market-data endpoint unreachable');
    if (this.config.mode === 'mt5' && !contractsReady) {
      issues.push('MT5 broker contracts unavailable or expired');
    }

    // ── Database ──────────────────────────────────────────────────────────
    const dbOk = this.checkDB();
    if (!dbOk) issues.push('Database error');

    // ── Memory ────────────────────────────────────────────────────────────
    const memMB = process.memoryUsage().heapUsed / 1_048_576;
    const memOk = memMB < MAX_MEMORY_MB;
    if (!memOk) {
      issues.push(`High memory: ${memMB.toFixed(0)}MB`);
      if (!this.alertedMemory) {
        this.alertedMemory = true;
        await this.telegram.sendMessage(
          `⚠️ <b>Memory Warning</b>: ${memMB.toFixed(0)}MB (limit ${MAX_MEMORY_MB}MB)`
        ).catch(() => {});
      }
    } else {
      this.alertedMemory = false;
    }

    // ── Open trades anomaly ───────────────────────────────────────────────
    const openCount = this.db.getOpenTrades().length;
    if (openCount > MAX_OPEN_TRADES) {
      issues.push(`Anomalous open trades: ${openCount}`);
    }

    // ── Auto Emergency Stop on critical multi-failure ─────────────────────
    const criticalFail=!dbOk || ((!mt5Ok || !binanceOk) && openCount>0) ||
      (this.config.mode === 'mt5' && !contractsReady && openCount>0);
    if (criticalFail) {
      this.failStreak++;
      if (this.failStreak >= 3 && !this.emergency.isActive()) {
        await this.emergency.activate(
          `HealthMonitor: ${issues.join(', ')} (${this.failStreak} consecutive failures)`
        );
      }
    } else {
      this.failStreak = 0;
    }

    this.status = {
      ok:         issues.length === 0,
      mt5:        mt5Ok,
      binance:    binanceOk,
      contractsReady,
      db:         dbOk,
      memoryMB:   Math.round(memMB),
      memoryOk:   memOk,
      uptime:     Math.floor((Date.now() - this.startedAt) / 1000),
      openTrades: openCount,
      checkedAt:  Date.now(),
      issues,
    };

    if (issues.length > 0) {
      this.logger.warn(`Health issues: ${issues.join(', ')}`);
    }
  }

  private async checkMT5(): Promise<boolean> {
    if (this.config.mode === 'binance') return true;
    try {
      const r = await axios.get(`${this.config.mt5.bridgeUrl}/health`, {
        timeout: 4000,
        headers: { 'X-Api-Key': this.config.mt5.bridgeApiKey ?? '' },
      });
      return r.data?.ok === true;
    } catch { return false; }
  }


  private resolveSources(): Set<'mt5'|'binance'>{
    const out=new Set<'mt5'|'binance'>();
    for(const raw of this.config.symbols){const s=raw.toUpperCase().replace(/[^A-Z0-9]/g,'');const b=/(USDT|USDC|BUSD)$/.test(s);if(this.config.mode==='mt5'||this.config.dataSource==='mt5'||(this.config.mode==='paper'&&this.config.dataSource==='auto'&&!b))out.add('mt5');if(this.config.mode==='binance'||this.config.dataSource==='binance'||(this.config.mode==='paper'&&this.config.dataSource==='auto'&&b))out.add('binance');}
    return out;
  }

  private async checkBinance():Promise<boolean>{try{const base=this.config.binance.futures?(this.config.binance.env==='testnet'?'https://testnet.binancefuture.com/fapi/v1/ping':'https://fapi.binance.com/fapi/v1/ping'):(this.config.binance.env==='testnet'?'https://testnet.binance.vision/api/v3/ping':'https://api.binance.com/api/v3/ping');await axios.get(base,{timeout:4000});return true;}catch{return false;}}

  private checkDB(): boolean {
    try { this.db.getSetting('__health__'); return true; }
    catch { return false; }
  }
}
