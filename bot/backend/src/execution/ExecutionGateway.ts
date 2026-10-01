import axios from 'axios';
import * as crypto from 'crypto';
import { SystemConfig, Signal, Trade, Timeframe } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { BinanceExecutor } from './BinanceExecutor';
import { PaperTrader } from '../integration/PaperTrader';
import { Logger } from '../utils/Logger';

export interface ExecutionResult {
  success: boolean;
  trade?: Trade;
  error?: string;
  retries: number;
}

export class ExecutionGateway {
  private partialLocks = new Map<number, number>();
  private logger = new Logger('Execution');
  private paper: PaperTrader;
  private binance: BinanceExecutor;

  constructor(private config: SystemConfig, private db: DatabaseManager) {
    this.paper = new PaperTrader(config.accountBalance);
    this.binance = new BinanceExecutor(config);
  }

  async initialize() {
    if (this.config.mode === 'paper') {
      const open = this.db.getOpenTrades();
      const closed = this.db.getRecentClosedTrades(100000);
      this.paper.restoreState(open, closed);
      this.logger.info(`Execution PAPER | open=${open.length} closed=${closed.length}`);
    } else if (this.config.mode === 'binance') {
      const ok = await this.binance.ping();
      if (!ok) throw new Error('[Execution] Binance connectivity check failed');
      this.logger.info(`Binance connected (${this.config.binance.futures ? 'Futures' : 'Spot'})`);
    } else {
      const r = await axios.get(`${this.config.mt5.bridgeUrl}/ping`, {
        timeout: 4_000,
        headers: this.mt5Headers(),
      });
      if (r.data?.ok !== true || r.data?.mode !== 'live') {
        throw new Error('[Execution] MT5 bridge is not explicitly reporting live mode');
      }
      this.logger.info(`Execution MT5 (${this.config.mt5.bridgeUrl})`);
    }
  }

  async execute(signal: Signal, volume: number, timeframe: Timeframe): Promise<ExecutionResult> {
    const operationKey = this.stableKey('OPEN', {
      account: this.config.accountName ?? 'default', mode: this.config.mode,
      symbol: signal.symbol, side: signal.side, timestamp: signal.timestamp,
      timeframe, volume, source: signal.source, sl: signal.sl, tp: signal.tp,
    });
    const existing = this.db.getExecutionByOperationKey(operationKey);
    if (existing) {
      if (existing.status === 'EXECUTED' && existing.resultJson) {
        return { success: true, trade: JSON.parse(existing.resultJson) as Trade, retries: existing.retryCount ?? 0 };
      }
      return {
        success: false,
        error: `Execution ${operationKey} already exists with status=${existing.status}; automatic retry is forbidden until reconciliation`,
        retries: existing.retryCount ?? 0,
      };
    }

    const executionId = crypto.randomUUID();
    this.db.createExecutionLedger({
      executionId, operationKey, action: 'OPEN', status: 'PENDING',
      symbol: signal.symbol, side: signal.side, volume,
      request: { timeframe, signal, volume },
    });

    const started = Date.now();
    const clientOrderId = this.config.mode === 'binance'
      ? this.makeClientOrderId(operationKey)
      : undefined;

    try {
      let trade: Trade | null = null;
      if (this.config.mode === 'mt5') trade = await this.executeMT5(signal, volume, timeframe, operationKey);
      else if (this.config.mode === 'binance') trade = await this.executeBinance(signal, volume, clientOrderId);
      else trade = this.paper.placeOrder(signal, volume, timeframe);
      if (!trade) throw new Error('No trade returned');

      const id = this.db.insertTrade({ ...trade, timeframe, account: this.config.accountName ?? 'default' });
      trade.id = id;
      this.db.updateExecutionLedger(executionId, {
        status: 'EXECUTED', brokerOrderId: trade.ticket, result: trade, retryCount: 0,
      });
      this.db.saveExecutionEvent({
        executionId, operationKey, symbol: signal.symbol, side: signal.side,
        action: 'OPEN', quantity: volume, price: trade.entry, status: 'EXECUTED',
        latencyMs: Date.now() - started,
      });
      return { success: true, trade, retries: 0 };
    } catch (e: any) {
      const message = e?.message ?? String(e);
      // Live broker failures are UNKNOWN, not FAILED: the request may have
      // reached the broker even when the HTTP call failed. This deliberately
      // blocks automatic retries until reconciliation resolves the state.
      const status = this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN';
      this.db.updateExecutionLedger(executionId, { status, error: message, retryCount: 0 });
      this.db.saveExecutionEvent({
        executionId, operationKey, symbol: signal.symbol, side: signal.side,
        action: 'OPEN', quantity: volume, status, latencyMs: Date.now() - started, error: message,
      });
      this.logger.error(`OPEN ${status}: ${message}`);
      return { success: false, error: message, retries: 0 };
    }
  }

  private async executeMT5(signal: Signal, volume: number, tf: Timeframe, operationKey: string): Promise<Trade> {
    const comment = `ta_${crypto.createHash('sha256').update(operationKey).digest('hex').slice(0, 27)}`.slice(0, 31);
    const r = await axios.post(`${this.config.mt5.bridgeUrl}/trade`, {
      symbol: signal.symbol, side: signal.side, volume, sl: signal.sl, tp: signal.tp, comment,
      idempotency_key: operationKey,
    }, { timeout: 8_000, headers: this.mt5Headers() });
    if (!r.data?.ticket) throw new Error(`MT5 no ticket: ${JSON.stringify(r.data)}`);
    return {
      ticket: Number(r.data.ticket), symbol: signal.symbol, side: signal.side, volume,
      entry: Number(r.data.price ?? signal.price), sl: signal.sl, tp: signal.tp,
      status: 'open', openedAt: Date.now(), source: signal.source, timeframe: tf,
    };
  }

  private async executeBinance(signal: Signal, volume: number, clientOrderId?: string): Promise<Trade> {
    const t = await this.binance.placeMarketOrder(signal, volume, clientOrderId);
    if (!t) throw new Error('Binance order failed or protection did not reach a verified safe state');
    return t;
  }

  private makeClientOrderId(operationKey: string): string {
    const digest = crypto.createHash('sha256').update(operationKey).digest('hex').slice(0, 28);
    return `ta_${digest}`.slice(0, 36);
  }

  async getCurrentEquity(): Promise<number | null> {
    try {
      if (this.config.mode === 'paper') return this.paper.getBalance();
      if (this.config.mode === 'mt5') {
        const r = await axios.get(`${this.config.mt5.bridgeUrl}/account`, {
          timeout: 4_000, headers: this.mt5Headers(),
        });
        const equity = Number(r.data?.equity);
        return Number.isFinite(equity) && equity > 0 ? equity : null;
      }
      const equity = await this.binance.accountEquity();
      return Number.isFinite(equity) && equity > 0 ? equity : null;
    } catch (e: any) {
      this.logger.error(`getCurrentEquity failed: ${e?.message ?? e}`);
      return null;
    }
  }

  getPaperStats() { return this.config.mode === 'paper' ? this.paper.getStats() : null; }

  async modifySLTP(t: Trade, newSl: number, newTp: number) {
    const key = this.stableKey('MOVE_SL_TP', { id: t.id, ticket: t.ticket, symbol: t.symbol, sl: newSl, tp: newTp });
    const op = this.beginDestructive(key, 'MOVE_SL_TP', t, { newSl, newTp });
    if (op.existing) return op.existing.status === 'EXECUTED';
    try {
      if (this.config.mode === 'mt5') {
        if (!t.ticket) throw new Error('Trade has no broker ticket');
        await axios.post(`${this.config.mt5.bridgeUrl}/modify`, { ticket: t.ticket, sl: newSl, tp: newTp }, { timeout: 5_000, headers: this.mt5Headers() });
      } else if (this.config.mode === 'binance') {
        if (!t.ticket || !(await this.binance.modifyPosition(t.ticket, t.symbol, t.side, newSl, newTp))) throw new Error('Binance modify rejected');
      } else {
        if (!t.ticket || !this.paper.modifyTrade(t.ticket, newSl, newTp)) throw new Error('Paper modify rejected');
      }
      if (t.id) this.db.raw().prepare('UPDATE trades SET sl=?,tp=? WHERE id=?').run(newSl, newTp, t.id);
      this.db.updateExecutionLedger(op.executionId, { status: 'EXECUTED' });
      return true;
    } catch (e: any) {
      this.db.updateExecutionLedger(op.executionId, { status: this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN', error: e?.message ?? String(e) });
      this.logger.error(`modifySLTP: ${e?.message ?? e}`);
      return false;
    }
  }

  async closeTrade(t: Trade) {
    const key = this.stableKey('CLOSE', { id: t.id, ticket: t.ticket, symbol: t.symbol, volume: t.volume });
    const op = this.beginDestructive(key, 'CLOSE', t, {});
    if (op.existing) return op.existing.status === 'EXECUTED';
    try {
      if (this.config.mode === 'mt5') {
        if (!t.ticket) throw new Error('Trade has no broker ticket');
        await axios.post(`${this.config.mt5.bridgeUrl}/close`, { ticket: t.ticket, idempotency_key: key }, { timeout: 8_000, headers: this.mt5Headers() });
      } else if (this.config.mode === 'binance') {
        if (!t.ticket || !(await this.binance.closePosition(t.ticket, t.symbol, t.volume))) throw new Error('Binance close rejected');
      } else {
        throw new Error('Paper close requires closeAtMarket so the exit price is explicit');
      }
      this.db.updateExecutionLedger(op.executionId, { status: 'EXECUTED' });
      return true;
    } catch (e: any) {
      this.db.updateExecutionLedger(op.executionId, { status: this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN', error: e?.message ?? String(e) });
      this.logger.error(`closeTrade: ${e?.message ?? e}`);
      return false;
    }
  }

  async closeAtMarket(t: Trade, exitPrice: number, reason: 'TP'|'SL'|'TIMEOUT'|'MANUAL' = 'MANUAL') {
    const key = this.stableKey('CLOSE_AT_MARKET', { id: t.id, ticket: t.ticket, symbol: t.symbol, volume: t.volume, exitPrice, reason });
    const op = this.beginDestructive(key, 'CLOSE_AT_MARKET', t, { exitPrice, reason });
    if (op.existing) return { ok: op.existing.status === 'EXECUTED', profit: undefined };
    try {
      if (this.config.mode === 'paper') {
        const result = this.settlePaperTrade(t, exitPrice, reason);
        if (!result.ok) throw new Error('Paper settlement rejected');
        if (t.id) this.db.updateTradeClose(t.id, result.profit, Date.now(), reason);
        this.db.updateExecutionLedger(op.executionId, { status: 'EXECUTED', result });
        return { ok: true, profit: result.profit };
      }
      const ok = await this.closeTrade(t);
      if (!ok) throw new Error('Broker close could not be verified');
      this.db.updateExecutionLedger(op.executionId, { status: 'EXECUTED' });
      return { ok: true };
    } catch (e: any) {
      this.db.updateExecutionLedger(op.executionId, { status: this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN', error: e?.message ?? String(e) });
      this.logger.error(`closeAtMarket: ${e?.message ?? e}`);
      return { ok: false };
    }
  }

  async closePartial(t: Trade, volume: number, exitPrice: number, reason = 'PARTIAL'): Promise<{ok:boolean;profit:number;remainingVolume:number}> {
    if (!(volume > 0) || volume >= t.volume) return { ok: false, profit: 0, remainingVolume: t.volume };
    if (t.id) {
      const lockUntil = this.partialLocks.get(t.id) ?? 0;
      if (Date.now() < lockUntil) return { ok: false, profit: 0, remainingVolume: t.volume };
      this.partialLocks.set(t.id, Date.now() + 120_000);
      setTimeout(() => this.partialLocks.delete(t.id!), 125_000).unref?.();
    }
    const key = this.stableKey('PARTIAL_CLOSE', { id: t.id, ticket: t.ticket, symbol: t.symbol, volume, exitPrice, reason });
    const op = this.beginDestructive(key, 'PARTIAL_CLOSE', t, { volume, exitPrice, reason });
    if (op.existing) return { ok: op.existing.status === 'EXECUTED', profit: 0, remainingVolume: t.volume };

    try {
      if (this.config.mode === 'paper') {
        if (!t.ticket) throw new Error('Paper trade has no ticket');
        const result = this.paper.partialClose(t.ticket, volume, exitPrice, reason);
        if (!result.ok) throw new Error('Paper partial close rejected');
        if (t.id) this.db.raw().prepare(`UPDATE trades SET volume=?, realizedProfit=COALESCE(realizedProfit,0)+?, notes=COALESCE(notes,'') || ? WHERE id=?`).run(result.remainingVolume, result.profit, `\npartial_pnl=${result.profit.toFixed(8)}`, t.id);
        this.db.updateExecutionLedger(op.executionId, { status: 'EXECUTED', result });
        return result;
      }
      let remaining = +(t.volume - volume).toFixed(8);
      let realizedProfit = 0;

      if (this.config.mode === 'mt5') {
        if (!t.ticket) throw new Error('Trade has no broker ticket');
        const fraction = volume / t.volume;
        const r = await axios.post(
          `${this.config.mt5.bridgeUrl}/close_partial`,
          { ticket: t.ticket, fraction, idempotency_key: key },
          { timeout: 8_000, headers: this.mt5Headers() },
        );
        const brokerRemaining = Number(r.data?.remaining_volume);
        const brokerProfit = Number(r.data?.profit ?? 0);
        if (!Number.isFinite(brokerRemaining) || brokerRemaining < 0 || brokerRemaining > t.volume) {
          throw new Error('MT5 partial close returned invalid remaining_volume');
        }
        if (!Number.isFinite(brokerProfit)) {
          throw new Error('MT5 partial close returned invalid profit');
        }
        remaining = +brokerRemaining.toFixed(8);
        realizedProfit = +brokerProfit.toFixed(8);
      } else if (this.config.mode === 'binance') {
        if (!t.ticket || !(await this.binance.closePartialPosition(t.ticket, t.symbol, volume))) throw new Error('Binance partial close rejected');
      } else {
        if (!t.ticket) throw new Error('Paper trade has no ticket');
        const result = this.paper.partialClose(t.ticket, volume, exitPrice, reason);
        if (!result.ok) throw new Error('Paper partial close rejected');
        remaining = result.remainingVolume;
        realizedProfit = result.profit;
      }

      if (t.id) this.db.raw().prepare(`UPDATE trades SET volume=?, realizedProfit=COALESCE(realizedProfit,0)+?, notes=COALESCE(notes,'') || ? WHERE id=?`).run(remaining, realizedProfit, `\npartial_volume=${volume}\npartial_pnl=${realizedProfit.toFixed(8)}`, t.id);
      this.db.updateExecutionLedger(op.executionId, { status: 'EXECUTED', result: { remainingVolume: remaining, profit: realizedProfit } });
      return { ok: true, profit: realizedProfit, remainingVolume: remaining };
    } catch (e: any) {
      this.db.updateExecutionLedger(op.executionId, { status: this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN', error: e?.message ?? String(e) });
      this.logger.error(`closePartial: ${e?.message ?? e}`);
      return { ok: false, profit: 0, remainingVolume: t.volume };
    }
  }

  settlePaperTrade(t: Trade, exitPrice: number, reason: 'TP'|'SL'|'TIMEOUT'|'MANUAL') {
    if (this.config.mode !== 'paper' || !t.ticket) return { ok: false, profit: 0 };
    return this.paper.closeTrade(t.ticket, exitPrice, reason);
  }

  getBinancePosition(symbol: string) { return this.binance.getPosition(symbol); }

  private beginDestructive(operationKey: string, action: string, trade: Trade, request: Record<string, unknown>) {
    const existing = this.db.getExecutionByOperationKey(operationKey);
    if (existing) return { executionId: String(existing.executionId), existing };
    const executionId = crypto.randomUUID();
    this.db.createExecutionLedger({
      executionId, operationKey, action, status: 'PENDING', symbol: trade.symbol,
      side: trade.side, volume: trade.volume, request: { tradeId: trade.id, ...request },
    });
    return { executionId, existing: null };
  }

  private stableKey(action: string, payload: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(`${action}:${JSON.stringify(payload, Object.keys(payload).sort())}`).digest('hex');
  }

  private mt5Headers() {
    return this.config.mt5.bridgeApiKey ? { 'X-Api-Key': this.config.mt5.bridgeApiKey } : {};
  }
}
