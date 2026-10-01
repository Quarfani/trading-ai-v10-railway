import axios from 'axios';
import * as crypto from 'crypto';
import { SystemConfig, Signal, Trade, Timeframe } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';
import { BinanceExecutor } from './BinanceExecutor';
import { PaperTrader } from '../integration/PaperTrader';
import { Logger } from '../utils/Logger';
import { getBrokerMarketDefinition, getMarketDefinition } from '../market/MarketCatalog';
import { CurrencyConversionProvider } from '../market/CurrencyConversionProvider';

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

  constructor(
    private config: SystemConfig,
    private db: DatabaseManager,
    private currencyRates?: CurrencyConversionProvider,
  ) {
    this.paper = new PaperTrader(
      config.accountBalance,
      config.accountCurrency ?? 'USD',
    );
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
        try {
          return { success: true, trade: JSON.parse(existing.resultJson) as Trade, retries: existing.retryCount ?? 0 };
        } catch {
          return {
            success: false,
            error: 'Persisted EXECUTED result is invalid; manual reconciliation is required and no broker request was sent',
            retries: existing.retryCount ?? 0,
          };
        }
      }
      return {
        success: false,
        error: `Execution ${operationKey} already exists with status=${existing.status}; automatic retry is forbidden until reconciliation`,
        retries: existing.retryCount ?? 0,
      };
    }

    const executionId = crypto.randomUUID();
    const claimed = this.db.createExecutionLedger({
      executionId, operationKey, action: 'OPEN', status: 'PENDING',
      symbol: signal.symbol, side: signal.side, volume,
      request: { timeframe, signal, volume },
    });
    if (!claimed) {
      const raced = this.db.getExecutionByOperationKey(operationKey);
      if (raced?.status === 'EXECUTED' && raced.resultJson) {
        try {
          return {
            success: true,
            trade: JSON.parse(raced.resultJson) as Trade,
            retries: raced.retryCount ?? 0,
          };
        } catch {
          return {
            success: false,
            error: 'Persisted racing EXECUTED result is invalid; manual reconciliation is required and no broker request was sent',
            retries: raced.retryCount ?? 0,
          };
        }
      }
      return {
        success: false,
        error: raced
          ? `Execution ${operationKey} already exists with status=${raced.status}; automatic retry is forbidden until reconciliation`
          : 'Execution ledger claim raced but no owner row is visible; no broker request was sent',
        retries: raced?.retryCount ?? 0,
      };
    }

    const started = Date.now();
    const clientOrderId = this.config.mode === 'binance'
      ? this.makeClientOrderId(operationKey)
      : undefined;

    try {
      let trade: Trade | null = null;
      if (this.config.mode === 'mt5') trade = await this.executeMT5(signal, volume, timeframe, operationKey);
      else if (this.config.mode === 'binance') trade = await this.executeBinance(signal, volume, clientOrderId);
      else {
        const quoteToAccount = await this.resolvePaperQuoteToAccount(signal.symbol, timeframe);
        trade = this.paper.placeOrder(signal, volume, timeframe, quoteToAccount);
      }
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
    const market = getBrokerMarketDefinition(signal.symbol, tf);
    if (!market) throw new Error(`MT5 broker contract unavailable or expired for ${signal.symbol}/${tf}`);
    const brokerSymbol = market.brokerSymbol ?? signal.symbol;
    const comment = `ta_${crypto.createHash('sha256').update(operationKey).digest('hex').slice(0, 27)}`.slice(0, 31);
    const r = await axios.post(`${this.config.mt5.bridgeUrl}/trade`, {
      symbol: brokerSymbol, side: signal.side, volume, sl: signal.sl, tp: signal.tp, comment,
      idempotency_key: operationKey,
    }, { timeout: 8_000, headers: this.mt5Headers() });
    if (!r.data?.ticket) throw new Error(`MT5 no ticket: ${JSON.stringify(r.data)}`);
    const executedVolume = Number(r.data.volume ?? volume);
    if (!(executedVolume > 0) || !Number.isFinite(executedVolume)) {
      throw new Error(`MT5 invalid executed volume: ${JSON.stringify(r.data)}`);
    }
    return {
      ticket: Number(r.data.ticket),
      symbol: brokerSymbol,
      side: signal.side,
      volume: executedVolume,
      entry: Number(r.data.price ?? signal.price),
      sl: signal.sl,
      tp: signal.tp,
      status: 'open',
      openedAt: Date.now(),
      source: signal.source,
      timeframe: tf,
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

  async getMT5PositionMode(): Promise<'HEDGING' | 'NETTING_OR_EXCHANGE' | 'UNKNOWN' | null> {
    if (this.config.mode !== 'mt5') return null;
    try {
      const r = await axios.get(`${this.config.mt5.bridgeUrl}/account`, {
        timeout: 4_000,
        headers: this.mt5Headers(),
      });
      const mode = String(r.data?.position_mode ?? 'UNKNOWN').toUpperCase();
      if (mode === 'HEDGING' || mode === 'NETTING_OR_EXCHANGE') return mode;
      return 'UNKNOWN';
    } catch (e: any) {
      this.logger.warn(`getMT5PositionMode failed: ${e?.message ?? e}`);
      return null;
    }
  }

  async getCurrentEquity(): Promise<number | null> {
    try {
      if (this.config.mode === 'paper') return this.paper.getBalance();

      if (this.config.mode === 'mt5') {
        const r = await axios.get(`${this.config.mt5.bridgeUrl}/account`, {
          timeout: 4_000,
          headers: this.mt5Headers(),
        });
        const equity = Number(r.data?.equity);
        return Number.isFinite(equity) && equity > 0 ? equity : null;
      }

      // Binance USD-M Futures and Spot equity is reported in the Binance
      // wallet unit (USDT in this executor). Convert it explicitly into the
      // configured account currency before risk decisions.
      const rawEquity = await this.binance.accountEquity();
      const accountCurrency = (this.config.accountCurrency ?? 'USD').trim().toUpperCase();
      if (accountCurrency === 'USD' || accountCurrency === 'USDT') return rawEquity;

      const conversion = await this.currencyRates?.getRate('USDT');
      if (!(conversion != null && conversion > 0 && Number.isFinite(conversion))) {
        this.logger.error(`Binance equity conversion unavailable: USDT->${accountCurrency}`);
        return null;
      }
      const equity = rawEquity * conversion;
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
        const response = await axios.post(
          `${this.config.mt5.bridgeUrl}/modify`,
          {
            ticket: t.ticket,
            sl: newSl,
            tp: newTp,
            idempotency_key: key,
          },
          {
            timeout: 5_000,
            headers: this.mt5Headers(),
          },
        );
        if (response.data?.ok !== true) {
          throw new Error(
            `MT5 modify returned non-success response: ${JSON.stringify(response.data)}`,
          );
        }
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

  private async convertBrokerProfitToAccount(
    profit: number,
    profitCurrency: string | null,
  ): Promise<number> {
    if (!Number.isFinite(profit)) {
      throw new Error('Broker realized PnL is not finite');
    }

    const accountCurrency = (
      this.config.accountCurrency ?? 'USD'
    ).trim().toUpperCase();
    const currency = (profitCurrency ?? '').trim().toUpperCase();
    if (!currency || currency === accountCurrency) return profit;

    if (
      accountCurrency === 'USD' &&
      ['USDT', 'USDC', 'BUSD'].includes(currency)
    ) {
      return profit;
    }

    const rate = await this.currencyRates?.getRate(currency);
    if (
      rate == null ||
      !(rate > 0) ||
      !Number.isFinite(rate)
    ) {
      throw new Error(
        `Broker PnL conversion unavailable: ${currency}->${accountCurrency}`,
      );
    }

    const converted = profit * rate;
    if (!Number.isFinite(converted)) {
      throw new Error('Converted broker PnL is not finite');
    }
    return converted;
  }

  private async closeBrokerTrade(
    t: Trade,
    operationKey: string,
  ): Promise<{ realizedProfit: number | null }> {
    if (this.config.mode === 'mt5') {
      if (!t.ticket) throw new Error('Trade has no broker ticket');

      const response = await axios.post(
        `${this.config.mt5.bridgeUrl}/close`,
        { ticket: t.ticket, idempotency_key: operationKey },
        { timeout: 8_000, headers: this.mt5Headers() },
      );

      if (response.data?.ok === false) {
        throw new Error(
          `MT5 close rejected: ${response.data?.error ?? 'unknown error'}`,
        );
      }

      const realizedProfit = Number(response.data?.profit);
      if (!Number.isFinite(realizedProfit)) {
        throw new Error(
          'MT5 close returned success without a finite realized profit',
        );
      }

      return { realizedProfit };
    }

    if (this.config.mode === 'binance') {
      if (!t.ticket) throw new Error('Trade has no broker ticket');

      const result = await this.binance.closePosition(
        t.ticket,
        t.symbol,
        t.volume,
        t.side,
      );

      if (!result.ok) throw new Error('Binance close rejected');
      const realizedProfit = result.realizedProfit == null
        ? null
        : await this.convertBrokerProfitToAccount(
            result.realizedProfit,
            result.realizedProfitCurrency,
          );
      return { realizedProfit };
    }

    throw new Error('Paper close must use closeAtMarket');
  }

  async closeTrade(t: Trade) {
    const key = this.stableKey('CLOSE', {
      id: t.id,
      ticket: t.ticket,
      symbol: t.symbol,
      volume: t.volume,
    });
    const op = this.beginDestructive(key, 'CLOSE', t, {});
    if (op.existing) return op.existing.status === 'EXECUTED';

    try {
      const brokerResult = await this.closeBrokerTrade(t, key);

      if (
        brokerResult.realizedProfit != null &&
        Number.isFinite(brokerResult.realizedProfit) &&
        t.id
      ) {
        const changed = this.db.updateTradeClose(
          t.id,
          brokerResult.realizedProfit,
          Date.now(),
          'MANUAL',
        );
        if (!changed) {
          throw new Error(
            `Broker close succeeded but trade settlement could not be persisted for id=${t.id}`,
          );
        }
      }

      this.db.updateExecutionLedger(op.executionId, {
        status: 'EXECUTED',
        result: brokerResult,
      });
      return true;
    } catch (e: any) {
      this.db.updateExecutionLedger(op.executionId, {
        status: this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN',
        error: e?.message ?? String(e),
      });
      this.logger.error(`closeTrade: ${e?.message ?? e}`);
      return false;
    }
  }

  async closeAtMarket(
    t: Trade,
    exitPrice: number,
    reason: 'TP'|'SL'|'TIMEOUT'|'MANUAL' = 'MANUAL',
  ) {
    const key = this.stableKey('CLOSE_AT_MARKET', {
      id: t.id,
      ticket: t.ticket,
      symbol: t.symbol,
      volume: t.volume,
      exitPrice,
      reason,
    });
    const op = this.beginDestructive(
      key,
      'CLOSE_AT_MARKET',
      t,
      { exitPrice, reason },
    );
    if (op.existing) {
      if (op.existing.status !== 'EXECUTED') return { ok: false };
      try {
        const persisted = op.existing.resultJson
          ? JSON.parse(op.existing.resultJson)
          : null;
        return {
          ok: true,
          profit: persisted?.realizedProfit ?? persisted?.profit ?? undefined,
        };
      } catch {
        return { ok: false };
      }
    }

    try {
      if (this.config.mode === 'paper') {
        const quoteToAccount =
          await this.resolvePaperQuoteToAccount(
            t.symbol,
            t.timeframe ?? 'H1',
          );
        const result = this.settlePaperTrade(
          t,
          exitPrice,
          reason,
          quoteToAccount,
        );
        if (!result.ok) throw new Error('Paper settlement rejected');

        if (t.id) {
          const changed = this.db.updateTradeClose(
            t.id,
            result.profit,
            Date.now(),
            reason,
            quoteToAccount,
          );
          if (!changed) {
            throw new Error(
              `Paper settlement could not be persisted for id=${t.id}`,
            );
          }
        }

        this.db.updateExecutionLedger(
          op.executionId,
          { status: 'EXECUTED', result },
        );
        return { ok: true, profit: result.profit };
      }

      const brokerResult = await this.closeBrokerTrade(t, key);

      if (
        brokerResult.realizedProfit != null &&
        Number.isFinite(brokerResult.realizedProfit) &&
        t.id
      ) {
        const changed = this.db.updateTradeClose(
          t.id,
          brokerResult.realizedProfit,
          Date.now(),
          reason,
        );
        if (!changed) {
          throw new Error(
            `Broker close succeeded but trade settlement could not be persisted for id=${t.id}`,
          );
        }
      }

      this.db.updateExecutionLedger(
        op.executionId,
        { status: 'EXECUTED', result: brokerResult },
      );
      return {
        ok: true,
        profit: brokerResult.realizedProfit ?? undefined,
      };
    } catch (e: any) {
      this.db.updateExecutionLedger(
        op.executionId,
        {
          status: this.config.mode === 'paper'
            ? 'FAILED'
            : 'UNKNOWN',
          error: e?.message ?? String(e),
        },
      );
      this.logger.error(
        `closeAtMarket: ${e?.message ?? e}`,
      );
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
    if (op.existing) {
      if (op.existing.status !== 'EXECUTED') {
        return { ok: false, profit: 0, remainingVolume: t.volume };
      }
      try {
        const persisted = op.existing.resultJson
          ? JSON.parse(op.existing.resultJson)
          : null;
        const profit = Number(persisted?.profit);
        const remainingVolume = Number(persisted?.remainingVolume);
        if (!Number.isFinite(profit) || !Number.isFinite(remainingVolume)) {
          return { ok: false, profit: 0, remainingVolume: t.volume };
        }
        return { ok: true, profit, remainingVolume };
      } catch {
        return { ok: false, profit: 0, remainingVolume: t.volume };
      }
    }

    try {
      if (this.config.mode === 'paper') {
        if (!t.ticket) throw new Error('Paper trade has no ticket');
        const quoteToAccount = await this.resolvePaperQuoteToAccount(t.symbol, t.timeframe ?? 'H1');
        const result = this.paper.partialClose(t.ticket, volume, exitPrice, reason, quoteToAccount);
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
        if (!t.ticket) throw new Error('Binance partial close requires broker ticket');
        const result = await this.binance.closePartialPosition(
          t.ticket,
          t.symbol,
          volume,
        );
        if (!result.ok) throw new Error('Binance partial close rejected');
        remaining = result.remainingVolume;
        realizedProfit = result.realizedProfit;
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

  settlePaperTrade(t: Trade, exitPrice: number, reason: 'TP'|'SL'|'TIMEOUT'|'MANUAL', quoteToAccount=1) {
    if (this.config.mode !== 'paper' || !t.ticket) return { ok: false, profit: 0 };
    return this.paper.closeTrade(t.ticket, exitPrice, reason, Date.now(), quoteToAccount);
  }

  private async resolvePaperQuoteToAccount(symbol: string, timeframe: Timeframe): Promise<number> {
    const market = getMarketDefinition(symbol, timeframe);
    if (!market) throw new Error(`Paper market definition missing for ${symbol}/${timeframe}`);
    const account = (this.config.accountCurrency ?? 'USD').trim().toUpperCase();
    const quote = market.quoteCurrency.trim().toUpperCase();
    if (quote === account) return 1;
    if (!this.currencyRates) {
      throw new Error(`Paper FX conversion unavailable for ${quote}->${account}`);
    }
    const rate = await this.currencyRates.getRate(quote);
    if (!(rate != null && rate > 0 && Number.isFinite(rate))) {
      throw new Error(`Paper FX conversion unavailable for ${quote}->${account}`);
    }
    return rate;
  }

  getBinancePosition(symbol: string) { return this.binance.getPosition(symbol); }

  private beginDestructive(operationKey: string, action: string, trade: Trade, request: Record<string, unknown>) {
    const existing = this.db.getExecutionByOperationKey(operationKey);
    if (existing) return { executionId: String(existing.executionId), existing };
    const executionId = crypto.randomUUID();
    const claimed = this.db.createExecutionLedger({
      executionId, operationKey, action, status: 'PENDING', symbol: trade.symbol,
      side: trade.side, volume: trade.volume, request: { tradeId: trade.id, ...request },
    });
    if (claimed) return { executionId, existing: null };

    const raced = this.db.getExecutionByOperationKey(operationKey);
    if (raced) {
      return { executionId: String(raced.executionId), existing: raced };
    }
    throw new Error(
      `Execution ledger claim failed for ${action}; no broker request was sent`,
    );
  }

  private stableKey(action: string, payload: Record<string, unknown>): string {
    return crypto.createHash('sha256').update(`${action}:${JSON.stringify(payload, Object.keys(payload).sort())}`).digest('hex');
  }

  private mt5Headers() {
    return this.config.mt5.bridgeApiKey ? { 'X-Api-Key': this.config.mt5.bridgeApiKey } : {};
  }
}
