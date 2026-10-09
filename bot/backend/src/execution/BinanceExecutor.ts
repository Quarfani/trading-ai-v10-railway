/**
 * BINANCE EXECUTOR — v9.0 (COMPLETE FIX)
 * ═══════════════════════════════════════════════════════════════════════
 * [FIX-1] Real SL/TP Orders:
 *   يضع STOP_MARKET order للـ SL
 *   يضع TAKE_PROFIT_MARKET order للـ TP
 *   يتتبع orderId لكل SL/TP لإلغائها عند الإغلاق
 *
 * [FIX-2] Futures vs Spot:
 *   يستخدم fapi (Futures API) للـ SL/TP
 *   يدعم Spot و Futures في نفس الوقت
 *
 * [FIX-3] Position Management:
 *   يُتحقق من position side قبل الإغلاق
 *   يُلغي SL/TP orders عند الإغلاق اليدوي
 *
 * [FIX-4] Error Recovery:
 *   protective-order failure triggers emergency close; ambiguous live orders are reconciled by clientOrderId
 *   duplicate retries are prohibited
 * ═══════════════════════════════════════════════════════════════════════
 */
import axios, { AxiosInstance } from 'axios';
import * as crypto               from 'crypto';
import { Signal, SystemConfig, Trade } from '../types/trading.types';
import type { DatabaseManager } from '../database/DatabaseManager';
import { getSymbolSpec }               from '../config/symbolConfig';
import { Logger }                      from '../utils/Logger';

interface OpenOrderIds {
  slOrderId?: number;
  tpOrderId?: number;
  orderListId?: number;
  closeSide?: 'BUY'|'SELL';
  quantity?: number;
}

export class BinanceExecutor {
  private logger = new Logger('BinanceExecutor');
  private http:  AxiosInstance;
  private isFutures: boolean;
  // Map ticket → {slOrderId, tpOrderId}
  private orderMap = new Map<number, OpenOrderIds>();

  constructor(private config: SystemConfig, private db?: DatabaseManager) {
    const isTestnet=config.binance.env==='testnet';
    this.isFutures=config.binance.futures;
    const baseURL=this.isFutures?(isTestnet?'https://testnet.binancefuture.com':'https://fapi.binance.com'):(isTestnet?'https://testnet.binance.vision':'https://api.binance.com');

    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'X-MBX-APIKEY': config.binance.apiKey },
    });
  }

  private async emergencyCloseAfterProtectionFailure(
    signal: Signal,
    quantity: number,
    parentOperationKey?: string,
    entryClientOrderId?: string,
    entryEvidence?: Record<string, unknown>,
    failureReason = 'protection failure',
  ): Promise<void> {
    const db = this.db;
    if (!db) {
      throw new Error('Emergency close ledger is unavailable; refusing to send an untracked Binance order');
    }
    if (!parentOperationKey || !parentOperationKey.trim()) {
      throw new Error('Emergency close parent operation key is missing; refusing to send an untracked Binance order');
    }
    if (!(quantity > 0) || !Number.isFinite(quantity)) {
      throw new Error('Emergency close quantity is invalid');
    }

    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const spec = getSymbolSpec(signal.symbol);
    const emergencyOperationKey = 'PROTECTION_FAIL:' + parentOperationKey;
    const emergencyClientOrderId = this.makeClientOrderId(emergencyOperationKey);
    const existing = db.getExecutionByOperationKey(emergencyOperationKey);

    if (existing) {
      await this.recoverOrBlockExistingEmergencyClose(
        signal,
        quantity,
        parentOperationKey,
        entryClientOrderId,
        emergencyOperationKey,
        emergencyClientOrderId,
        existing,
      );
      return;
    }

    // Persist the intent before even querying live position state. If the
    // precheck fails, the parent OPEN still has a child incident to reconcile.
    const request = {
      schemaVersion: 1,
      purpose: 'PROTECTION_FAILURE_EMERGENCY_CLOSE',
      submissionState: 'PRECHECK_NOT_STARTED',
      protectionCleanupState: 'PENDING',
      parentOperationKey,
      parentClientOrderId: entryClientOrderId ?? null,
      symbol: String(signal.symbol).toUpperCase(),
      entrySide: signal.side,
      closeSide,
      requestedQuantity: quantity,
      positionBeforeAmount: null as number | null,
      positionBeforeSignedAmount: null as number | null,
      signal: { ...signal },
      entryEvidence: entryEvidence ? { ...entryEvidence } : null,
      failureReason: String(failureReason || 'protection failure').slice(0, 500),
      emergencyClientOrderId,
    };

    const executionId = crypto.randomUUID();
    const claimed = db.createExecutionLedger({
      executionId,
      operationKey: emergencyOperationKey,
      action: 'PROTECTION_FAIL_CLOSE',
      status: 'PENDING',
      symbol: signal.symbol,
      side: closeSide,
      volume: quantity,
      request,
    });
    if (!claimed) {
      throw new Error(
        'Emergency close intent could not be claimed; no order was sent and reconciliation is required',
      );
    }

    let beforeAmount = 0;
    let beforeSignedAmount = 0;
    let protectionCleanupVerified = false;
    let durableRequest: Record<string, any> = request;
    try {
      await this.cancelProtectionForEmergencyClose(signal, parentOperationKey);
      const cleanupVerifiedRequest = {
        ...durableRequest,
        protectionCleanupState: 'VERIFIED_NO_OPERATION_OWNED_ORDERS_ACTIVE',
      };
      if (!db.updateExecutionRequest(executionId, cleanupVerifiedRequest)) {
        throw new Error('Could not persist verified protection cleanup; no emergency order was sent');
      }
      durableRequest = cleanupVerifiedRequest;
      protectionCleanupVerified = true;

      const before = await this.getPosition(signal.symbol);
      if (!before) {
        throw new Error('Emergency close position state unavailable for ' + signal.symbol);
      }

      beforeSignedAmount = Number(before.positionAmt);
      beforeAmount = Math.abs(beforeSignedAmount);
      const quantityTolerance = Math.max(spec.volumeStep, Math.abs(quantity) * 0.0001);
      if (
        !Number.isFinite(beforeSignedAmount) ||
        !(beforeAmount > 0) ||
        (this.isFutures &&
          ((signal.side === 'BUY' && beforeSignedAmount <= 0) ||
           (signal.side === 'SELL' && beforeSignedAmount >= 0))) ||
        beforeAmount + quantityTolerance < quantity
      ) {
        throw new Error(
          'Emergency close quantity/direction exceeds verified Binance inventory for ' +
          signal.symbol + ': requested=' + quantity + ' available=' + beforeAmount,
        );
      }

      const armedRequest = {
        ...durableRequest,
        positionBeforeAmount: beforeAmount,
        positionBeforeSignedAmount: beforeSignedAmount,
        submissionState: 'SUBMISSION_ARMED',
      };
      if (!db.updateExecutionRequest(executionId, armedRequest)) {
        throw new Error('Could not persist emergency-close position snapshot; no order was sent');
      }
    } catch (e: any) {
      const cleanupError = String(e?.message ?? e).slice(0, 500);
      if (!protectionCleanupVerified) {
        const failedCleanupRequest = {
          ...durableRequest,
          protectionCleanupState: 'FAILED_OR_AMBIGUOUS',
          protectionCleanupError: cleanupError,
        };
        db.updateExecutionRequest(executionId, failedCleanupRequest);
      }
      db.updateExecutionLedger(executionId, {
        status: 'UNKNOWN',
        error: ('Emergency close protection-cleanup/precheck failed before order submission: ' +
          cleanupError).slice(0, 1000),
      });
      throw new Error(
        'Emergency close protection cleanup/precheck failed; no order was sent and startup/manual reconciliation is required: ' +
        cleanupError,
      );
    }

    let brokerResponse: any = null;
    try {
      brokerResponse = await this.signedPost(
        this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
        {
          symbol: signal.symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: this.formatQty(quantity, spec.volumeStep),
          ...(this.isFutures ? { reduceOnly: 'true' } : {}),
          newClientOrderId: emergencyClientOrderId,
        },
      );

      await this.verifyAndRecordEmergencyClose(
        executionId,
        emergencyOperationKey,
        emergencyClientOrderId,
        parentOperationKey,
        signal,
        quantity,
        beforeAmount,
        beforeSignedAmount,
        brokerResponse,
        entryClientOrderId,
        entryEvidence,
      );
    } catch (e: any) {
      const current = db.getExecutionByOperationKey(emergencyOperationKey);
      if (current && (current.status === 'PENDING' || current.status === 'UNKNOWN')) {
        const patch: any = {
          status: 'UNKNOWN',
          error: String(e?.message ?? e).slice(0, 1000),
        };
        if (brokerResponse && brokerResponse.orderId != null) {
          patch.brokerOrderId = brokerResponse.orderId;
        }
        if (brokerResponse) {
          patch.result = {
            schemaVersion: 1,
            emergencyClientOrderId,
            brokerOrderId: brokerResponse.orderId ?? null,
            brokerStatus: String(brokerResponse.status ?? 'UNKNOWN').toUpperCase(),
            executedQty: Number.isFinite(Number(brokerResponse.executedQty))
              ? Number(brokerResponse.executedQty)
              : null,
            positionBeforeAmount: beforeAmount,
            positionBeforeSignedAmount: beforeSignedAmount,
            positionDeltaVerified: false,
            parentOperationKey,
          };
        }
        db.updateExecutionLedger(String(current.executionId), patch);
      }
      throw new Error(
        'Emergency close could not be authoritatively confirmed for ' +
        signal.symbol + ': ' + String(e?.message ?? e),
      );
    }

    this.logger.error(
      '[Binance] Emergency close verified after protection failure: ' +
      signal.symbol + ' qty=' + quantity,
    );
  }

  private async recoverOrBlockExistingEmergencyClose(
    signal: Signal,
    quantity: number,
    parentOperationKey: string,
    entryClientOrderId: string | undefined,
    emergencyOperationKey: string,
    emergencyClientOrderId: string,
    existing: any,
  ): Promise<void> {
    const db = this.db;
    if (!db) throw new Error('Emergency close ledger is unavailable');

    let request: any;
    try {
      request = JSON.parse(String(existing.requestJson ?? 'null'));
    } catch {
      throw new Error('Existing emergency close ledger request is malformed; manual reconciliation is required');
    }
    const spec = getSymbolSpec(signal.symbol);
    const tolerance = Math.max(spec.volumeStep, Math.abs(quantity) * 0.0001);
    if (
      !request ||
      String(request.parentOperationKey ?? '') !== parentOperationKey ||
      String(request.symbol ?? '').toUpperCase() !== String(signal.symbol).toUpperCase() ||
      Math.abs(Number(request.requestedQuantity) - quantity) > tolerance ||
      (entryClientOrderId && String(request.parentClientOrderId ?? '') !== entryClientOrderId)
    ) {
      throw new Error('Existing emergency close identity conflicts with this open operation; manual reconciliation is required');
    }

    if (
      request.protectionCleanupState !==
      'VERIFIED_NO_OPERATION_OWNED_ORDERS_ACTIVE'
    ) {
      db.updateExecutionLedger(String(existing.executionId), {
        status: 'UNKNOWN',
        error: 'Existing emergency close has no durable protection-cleanup proof; automatic recovery is blocked',
      });
      throw new Error(
        'Existing emergency close lacks durable protection-cleanup proof; manual reconciliation is required and no automatic settlement is allowed',
      );
    }

    if (existing.status === 'EXECUTED') {
      let result: any;
      try {
        result = JSON.parse(String(existing.resultJson ?? 'null'));
      } catch {
        throw new Error('Executed emergency close result is malformed; manual reconciliation is required');
      }
      if (
        result?.positionDeltaVerified !== true ||
        String(result?.status ?? '').toUpperCase() !== 'FILLED' ||
        Math.abs(Number(result?.executedQty) - quantity) > tolerance ||
        !(Number(result?.orderId) > 0)
      ) {
        throw new Error('Executed emergency close lacks complete broker evidence; manual reconciliation is required');
      }
      return;
    }

    if (existing.status !== 'PENDING' && existing.status !== 'UNKNOWN') {
      throw new Error('Existing emergency close has terminal status=' + String(existing.status) + '; automatic retry is forbidden');
    }

    const beforeAmount = Number(request.positionBeforeAmount);
    const beforeSignedAmount = Number(request.positionBeforeSignedAmount);
    if (
      !(beforeAmount > 0) ||
      !Number.isFinite(beforeAmount) ||
      !Number.isFinite(beforeSignedAmount) ||
      Math.abs(Math.abs(beforeSignedAmount) - beforeAmount) >
        Math.max(spec.volumeStep, Math.abs(quantity) * 0.0001)
    ) {
      db.updateExecutionLedger(String(existing.executionId), {
        status: 'UNKNOWN',
        error: 'Stored signed pre-close inventory is missing or inconsistent; automatic retry is forbidden',
      });
      throw new Error('Stored signed pre-close inventory is unavailable; manual reconciliation is required');
    }

    let recovered: any = null;
    try {
      recovered = await this.findOrderByClientId(signal.symbol, emergencyClientOrderId);
    } catch {
      recovered = null;
    }
    if (!recovered) {
      db.updateExecutionLedger(String(existing.executionId), {
        status: 'UNKNOWN',
        error: 'Exact emergency clientOrderId was not found; no replacement order was sent',
      });
      throw new Error('Emergency close outcome is ambiguous; exact order was not found and no replacement order was sent');
    }

    try {
      await this.verifyAndRecordEmergencyClose(
        String(existing.executionId),
        emergencyOperationKey,
        emergencyClientOrderId,
        parentOperationKey,
        signal,
        quantity,
        beforeAmount,
        beforeSignedAmount,
        recovered,
        entryClientOrderId,
        request.entryEvidence ?? undefined,
      );
    } catch (e: any) {
      db.updateExecutionLedger(String(existing.executionId), {
        status: 'UNKNOWN',
        brokerOrderId: recovered.orderId ?? undefined,
        result: {
          schemaVersion: 1,
          emergencyClientOrderId,
          brokerOrderId: recovered.orderId ?? null,
          brokerStatus: String(recovered.status ?? 'UNKNOWN').toUpperCase(),
          executedQty: Number.isFinite(Number(recovered.executedQty))
            ? Number(recovered.executedQty)
            : null,
          positionBeforeAmount: beforeAmount,
          positionDeltaVerified: false,
          parentOperationKey,
        },
        error: String(e?.message ?? e).slice(0, 1000),
      });
      throw new Error('Recovered emergency close could not be verified; manual reconciliation is required');
    }
  }

  private async verifyAndRecordEmergencyClose(
    executionId: string,
    emergencyOperationKey: string,
    emergencyClientOrderId: string,
    parentOperationKey: string,
    signal: Signal,
    quantity: number,
    beforeAmount: number,
    beforeSignedAmount: number,
    brokerResponse: any,
    entryClientOrderId?: string,
    entryEvidence?: Record<string, unknown>,
  ): Promise<void> {
    const db = this.db;
    if (!db) throw new Error('Emergency close ledger is unavailable');

    const spec = getSymbolSpec(signal.symbol);
    const tolerance = Math.max(spec.volumeStep, Math.abs(quantity) * 0.0001);
    const responseSymbol = String(brokerResponse?.symbol ?? '').trim().toUpperCase();
    const responseClientOrderId = String(
      brokerResponse?.clientOrderId ?? brokerResponse?.origClientOrderId ?? '',
    );
    if (
      responseSymbol !== String(signal.symbol).trim().toUpperCase() ||
      responseClientOrderId !== emergencyClientOrderId
    ) {
      throw new Error('Emergency-close response symbol/clientOrderId does not match the submitted order');
    }
    const status = String(brokerResponse?.status ?? '').toUpperCase();
    const orderId = Number(brokerResponse?.orderId);
    const executedQty = Number(brokerResponse?.executedQty);
    if (status !== 'FILLED') {
      throw new Error('Emergency close order is not authoritatively FILLED; status=' + (status || 'MISSING'));
    }
    if (!(orderId > 0) || !Number.isFinite(orderId)) {
      throw new Error('Emergency close order id is missing or invalid');
    }
    if (
      !(executedQty > 0) ||
      !Number.isFinite(executedQty) ||
      Math.abs(executedQty - quantity) > tolerance
    ) {
      throw new Error(
        'Emergency close executed quantity mismatch: requested=' + quantity + ' executed=' + executedQty,
      );
    }

    const after = await this.getPosition(signal.symbol);
    if (!after) {
      throw new Error('Emergency close executed but post-close position state is unavailable for ' + signal.symbol);
    }
    const actualSignedAfter = Number(after.positionAmt);
    const remaining = Math.abs(actualSignedAfter);
    const expectedSignedAfter = this.isFutures
      ? beforeSignedAmount - (signal.side === 'BUY' ? executedQty : -executedQty)
      : beforeSignedAmount - executedQty;
    if (
      !Number.isFinite(beforeSignedAmount) ||
      Math.abs(Math.abs(beforeSignedAmount) - beforeAmount) > tolerance ||
      !Number.isFinite(actualSignedAfter) ||
      !Number.isFinite(expectedSignedAfter) ||
      (!this.isFutures && expectedSignedAfter < -tolerance) ||
      Math.abs(actualSignedAfter - expectedSignedAfter) > tolerance
    ) {
      throw new Error(
        'Emergency close signed inventory transition is unverified for ' +
        signal.symbol + ': beforeSigned=' + beforeSignedAmount +
        ' executed=' + executedQty + ' expectedAfter=' + expectedSignedAfter +
        ' actualAfter=' + actualSignedAfter,
      );
    }

    const result = {
      schemaVersion: 1,
      emergencyOperationKey,
      emergencyClientOrderId,
      parentOperationKey,
      parentClientOrderId: entryClientOrderId ?? null,
      orderId,
      status,
      requestedQuantity: quantity,
      executedQty,
      positionBeforeAmount: beforeAmount,
      positionBeforeSignedAmount: beforeSignedAmount,
      positionAfterAmount: remaining,
      positionAfterSignedAmount: actualSignedAfter,
      positionDeltaVerified: true,
      entryEvidence: entryEvidence ? { ...entryEvidence } : null,
      verifiedAt: Date.now(),
    };
    // Broker order/position evidence is durable, but trade PnL and the
    // parent OPEN ledger must be reconciled atomically before this child is terminal.
    const changed = db.updateExecutionLedger(executionId, {
      status: 'UNKNOWN',
      brokerOrderId: orderId,
      result,
      error: 'Broker close and position delta verified; authoritative PnL and parent OPEN settlement remain pending reconciliation',
    });
    if (!changed) {
      throw new Error('Broker close was verified but emergency ledger settlement failed');
    }
  }

  private async getSpotOrderFillSummary(
    symbol: string,
    orderId: number,
    expectedQty: number,
  ): Promise<{
    currency: string;
    avgPrice: number;
    feeQuote: number;
    totalQty: number;
    grossQuote: number;
  } | null> {
    if (
      this.isFutures ||
      !(orderId > 0) ||
      !Number.isFinite(orderId) ||
      !(expectedQty > 0) ||
      !Number.isFinite(expectedQty)
    ) {
      return null;
    }

    const quote = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
    if (!quote) return null;

    const trades = await this.signedGet('/api/v3/myTrades', {
      symbol,
      orderId,
      limit: 1000,
    });
    if (!Array.isArray(trades) || trades.length === 0) return null;

    const baseAsset = symbol.slice(0, -quote.length);
    let grossQuote = 0;
    let totalQty = 0;
    let feeQuote = 0;

    for (const fill of trades) {
      const price = Number(fill?.price);
      const qty = Number(fill?.qty);
      const commission = Number(fill?.commission ?? 0);
      const commissionAsset = String(fill?.commissionAsset ?? '').toUpperCase();
      if (
        !(price > 0) ||
        !Number.isFinite(price) ||
        !(qty > 0) ||
        !Number.isFinite(qty) ||
        !Number.isFinite(commission) ||
        commission < 0
      ) {
        return null;
      }
      if (!['USDT', 'USDC', 'BUSD', baseAsset].includes(commissionAsset)) {
        return null;
      }
      grossQuote += price * qty;
      totalQty += qty;
      if (commissionAsset === baseAsset) feeQuote += commission * price;
      else feeQuote += commission;
    }

    const tolerance = Math.max(
      getSymbolSpec(symbol).volumeStep,
      expectedQty * 0.0001,
    );
    if (
      !(totalQty > 0) ||
      !Number.isFinite(totalQty) ||
      Math.abs(totalQty - expectedQty) > tolerance ||
      !Number.isFinite(grossQuote) ||
      !Number.isFinite(feeQuote)
    ) {
      return null;
    }

    const avgPrice = grossQuote / totalQty;
    if (!(avgPrice > 0) || !Number.isFinite(avgPrice)) return null;

    return { currency: quote, avgPrice, feeQuote, totalQty, grossQuote };
  }

  private async getSpotOrderNetPnl(
    symbol: string,
    orderId: number,
    entryPrice: number,
    entrySide: 'BUY' | 'SELL',
    expectedExecutedQty: number,
  ): Promise<{ profit: number; currency: string; avgPrice: number | null } | null> {
    if (
      this.isFutures ||
      !(entryPrice > 0) ||
      !Number.isFinite(entryPrice)
    ) {
      return null;
    }

    const summary = await this.getSpotOrderFillSummary(
      symbol,
      orderId,
      expectedExecutedQty,
    );
    if (!summary) return null;

    const grossEntry = entryPrice * summary.totalQty;
    const exitNetQuote = summary.grossQuote - summary.feeQuote;
    const profit = entrySide === 'BUY'
      ? exitNetQuote - grossEntry
      : grossEntry - exitNetQuote;
    if (!Number.isFinite(profit)) return null;

    return {
      profit,
      currency: summary.currency,
      avgPrice: summary.avgPrice,
    };
  }

  private async getFuturesOrderFillSummary(
    symbol: string,
    orderId: number,
    expectedQty: number,
  ): Promise<{
    currency: string;
    avgPrice: number;
    commission: number;
    totalQty: number;
  } | null> {
    if (
      !this.isFutures ||
      !(orderId > 0) ||
      !Number.isFinite(orderId) ||
      !(expectedQty > 0) ||
      !Number.isFinite(expectedQty)
    ) {
      return null;
    }

    const fills = await this.signedGet('/fapi/v1/userTrades', {
      symbol,
      orderId,
    });
    if (!Array.isArray(fills) || fills.length === 0) return null;

    const quoteCurrency = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
    if (!quoteCurrency) return null;
    let currency = '';
    let weightedPrice = 0;
    let totalQty = 0;
    let commission = 0;

    for (const fill of fills) {
      const fillPrice = Number(fill?.price);
      const fillQty = Number(fill?.qty);
      const fee = Number(fill?.commission);
      const feeAsset = String(fill?.commissionAsset ?? '').toUpperCase();

      if (
        !(fillPrice > 0) ||
        !Number.isFinite(fillPrice) ||
        !(fillQty > 0) ||
        !Number.isFinite(fillQty) ||
        !Number.isFinite(fee) ||
        fee < 0 ||
        feeAsset !== quoteCurrency
      ) {
        return null;
      }

      if (!currency) currency = feeAsset;
      else if (currency !== feeAsset) return null;

      weightedPrice += fillPrice * fillQty;
      totalQty += fillQty;
      commission += fee;
    }

    const tolerance = Math.max(
      getSymbolSpec(symbol).volumeStep,
      expectedQty * 0.0001,
    );
    if (
      !currency ||
      !(totalQty > 0) ||
      !Number.isFinite(totalQty) ||
      Math.abs(totalQty - expectedQty) > tolerance ||
      !(commission >= 0) ||
      !Number.isFinite(commission)
    ) {
      return null;
    }

    const avgPrice = weightedPrice / totalQty;
    if (!(avgPrice > 0) || !Number.isFinite(avgPrice)) return null;

    return {
      currency,
      avgPrice,
      commission,
      totalQty,
    };
  }

  private async getFuturesOrderNetPnl(
    symbol: string,
    orderId: number,
  ): Promise<{ profit: number; currency: string; avgPrice: number | null } | null> {
    if (!this.isFutures || !(orderId > 0)) return null;

    const fills = await this.signedGet('/fapi/v1/userTrades', {
      symbol,
      orderId,
    });

    if (!Array.isArray(fills) || fills.length === 0) return null;

    const quoteCurrency = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
    if (!quoteCurrency) return null;

    let net = 0;
    let currency = '';
    let weightedPrice = 0;
    let totalQty = 0;

    for (const fill of fills) {
      const realizedPnl = Number(fill?.realizedPnl);
      const commission = Number(fill?.commission);
      const fillPrice = Number(fill?.price);
      const fillQty = Number(fill?.qty);
      const commissionAsset = String(
        fill?.commissionAsset ?? '',
      ).toUpperCase();

      if (
        !Number.isFinite(realizedPnl) ||
        !Number.isFinite(commission) ||
        commission < 0
      ) {
        return null;
      }

      // realizedPnl and commission must share a quote asset before subtraction.
      if (commissionAsset !== quoteCurrency) {
        return null;
      }

      if (!currency) currency = commissionAsset;
      else if (currency !== commissionAsset) return null;

      net += realizedPnl - commission;
      if (
        Number.isFinite(fillPrice) &&
        Number.isFinite(fillQty) &&
        fillPrice > 0 &&
        fillQty > 0
      ) {
        weightedPrice += fillPrice * fillQty;
        totalQty += fillQty;
      }
    }

    if (!currency || !Number.isFinite(net)) return null;
    const avgPrice = totalQty > 0 ? weightedPrice / totalQty : null;
    return {
      profit: net,
      currency,
      avgPrice: Number.isFinite(avgPrice ?? NaN) ? avgPrice : null,
    };
  }


  async recoverSpotOcoByOperation(
    symbol: string,
    operationKey: string,
  ): Promise<{
    orderListId: number;
    listStatusType: string;
    listOrderStatus: string;
    orders: any[];
  } | null> {
    if (this.isFutures) return null;
    try {
      const listClientOrderId = this.makeOcoClientOrderId(
        operationKey,
        'LIST',
      );
      const list = await this.getSpotOcoByClientId(
        symbol,
        listClientOrderId,
      );
      if (!list) return null;

      const listStatusType = String(list.listStatusType ?? '').toUpperCase();
      const listOrderStatus = String(list.listOrderStatus ?? '').toUpperCase();
      if (
        !['EXEC_STARTED', 'EXECUTING', 'ALL_DONE'].includes(listStatusType) &&
        !['EXECUTING', 'ALL_DONE'].includes(listOrderStatus)
      ) {
        return null;
      }

      if (
        String(list.symbol ?? '').toUpperCase() !== String(symbol).toUpperCase() ||
        String(list.listClientOrderId ?? '') !== listClientOrderId
      ) {
        return null;
      }

      const orders = Array.isArray(list.orders) ? list.orders : [];
      if (orders.length < 2) return null;

      const orderIds = orders
        .map((order: any) => Number(order.orderId))
        .filter((id: number) => Number.isFinite(id) && id > 0);
      if (orderIds.length !== 2 || new Set(orderIds).size !== 2) return null;

      return {
        orderListId: Number(list.orderListId),
        listStatusType,
        listOrderStatus,
        orders,
      };
    } catch (e: any) {
      this.logger.warn(
        `[Binance Spot] recoverSpotOcoByOperation failed: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  async recoverProtectionByOperation(
    symbol: string,
    operationKey: string,
  ): Promise<{
    sl: any | null;
    tp: any | null;
  }> {
    if (!operationKey || !operationKey.trim()) {
      throw new Error('Futures protection recovery requires its original operation key');
    }
    if (!this.isFutures) {
      const [sl, tp] = await Promise.all([
        this.findOrderByClientId(symbol, this.makeProtectionClientOrderId(operationKey, 'SL')),
        this.findOrderByClientId(symbol, this.makeProtectionClientOrderId(operationKey, 'TP')),
      ]);
      return { sl: sl ?? null, tp: tp ?? null };
    }

    const [sl, tp] = await Promise.all([
      this.getAlgoOrderByClientIdStrict(
        symbol,
        this.makeProtectionClientOrderId(operationKey, 'SL'),
      ),
      this.getAlgoOrderByClientIdStrict(
        symbol,
        this.makeProtectionClientOrderId(operationKey, 'TP'),
      ),
    ]);
    return { sl, tp };
  }

  clientOrderIdForOperationKey(operationKey: string): string {
    if (!operationKey || !operationKey.trim()) {
      throw new Error('Binance operation key is required to derive clientOrderId');
    }
    return this.makeClientOrderId(operationKey);
  }

  async recoverOperationFillDetails(
    symbol: string,
    operationKey: string,
    expectedQuantity: number,
  ): Promise<{
    orderId: number;
    clientOrderId: string;
    status: string;
    executedQty: number;
    avgPrice: number;
    commission: number;
    commissionCurrency: string;
    grossQuote?: number;
    feeQuote?: number;
    quoteCurrency?: string;
    brokerTimestamp: number;
  } | null> {
    return this.recoverOrderFillDetailsByClientOrderId(
      symbol,
      this.makeClientOrderId(operationKey),
      expectedQuantity,
    );
  }

  async recoverOrderFillDetailsByClientOrderId(
    symbol: string,
    clientOrderId: string,
    expectedQuantity: number,
  ): Promise<{
    orderId: number;
    clientOrderId: string;
    status: string;
    executedQty: number;
    avgPrice: number;
    commission: number;
    commissionCurrency: string;
    grossQuote?: number;
    feeQuote?: number;
    quoteCurrency?: string;
    brokerTimestamp: number;
  } | null> {
    if (
      !clientOrderId ||
      !(expectedQuantity > 0) ||
      !Number.isFinite(expectedQuantity)
    ) {
      return null;
    }
    try {
      const order = await this.findOrderByClientId(symbol, clientOrderId);
      if (!order) return null;
      const brokerClientOrderId = String(order.clientOrderId ?? order.origClientOrderId ?? '');
      if (
        brokerClientOrderId !== clientOrderId ||
        String(order.symbol ?? '').trim().toUpperCase() !== String(symbol).trim().toUpperCase()
      ) return null;
      const orderId = Number(order.orderId);
      const status = String(order.status ?? '').toUpperCase();
      const executedQty = Number(order.executedQty ?? order.cumQty ?? 0);
      if (
        !(orderId > 0) ||
        !Number.isFinite(orderId) ||
        status !== 'FILLED' ||
        !(executedQty > 0) ||
        !Number.isFinite(executedQty)
      ) {
        return null;
      }
      const tolerance = Math.max(
        getSymbolSpec(symbol).volumeStep,
        expectedQuantity * 0.0001,
      );
      if (Math.abs(executedQty - expectedQuantity) > tolerance) {
        return null;
      }

      const brokerTimestamp = Number(order.updateTime ?? order.time ?? 0);
      if (this.isFutures) {
        const summary = await this.getFuturesOrderFillSummary(
          symbol,
          orderId,
          executedQty,
        );
        if (!summary) return null;
        return {
          orderId,
          clientOrderId,
          status,
          executedQty: summary.totalQty,
          avgPrice: summary.avgPrice,
          commission: summary.commission,
          commissionCurrency: summary.currency,
          brokerTimestamp: Number.isFinite(brokerTimestamp) && brokerTimestamp > 0
            ? brokerTimestamp
            : Date.now(),
        };
      }

      const summary = await this.getSpotOrderFillSummary(
        symbol,
        orderId,
        executedQty,
      );
      if (!summary) return null;
      return {
        orderId,
        clientOrderId,
        status,
        executedQty: summary.totalQty,
        avgPrice: summary.avgPrice,
        commission: summary.feeQuote,
        commissionCurrency: summary.currency,
        grossQuote: summary.grossQuote,
        feeQuote: summary.feeQuote,
        quoteCurrency: summary.currency,
        brokerTimestamp: Number.isFinite(brokerTimestamp) && brokerTimestamp > 0
          ? brokerTimestamp
          : Date.now(),
      };
    } catch (e: any) {
      this.logger.warn(
        '[Binance] recoverOrderFillDetailsByClientOrderId failed: ' +
        String(e?.message ?? e),
      );
      return null;
    }
  }

  async recoverOperation(
    symbol: string,
    operationKey: string,
    entryPrice?: number,
    entrySide?: 'BUY' | 'SELL',
  ): Promise<{
    orderId: number;
    status: string;
    executedQty: number;
    avgPrice: number;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  } | null> {
    return this.recoverOrderByClientId(
      symbol,
      this.makeClientOrderId(operationKey),
      entryPrice,
      entrySide,
    );
  }

  async recoverOrderByClientId(
    symbol: string,
    clientOrderId: string,
    entryPrice?: number,
    entrySide?: 'BUY' | 'SELL',
  ): Promise<{
    orderId: number;
    status: string;
    executedQty: number;
    avgPrice: number;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  } | null> {
    try {
      const order = await this.findOrderByClientId(symbol, clientOrderId);
      if (!order) return null;
      const orderId = Number(order.orderId);
      const executedQty = Number(order.executedQty ?? order.cumQty ?? 0);
      const avgPrice = Number(order.avgPrice ?? 0);
      if (!(orderId > 0) || !Number.isFinite(orderId)) return null;
      if (!(executedQty >= 0) || !Number.isFinite(executedQty)) return null;

      if (!this.isFutures) {
        const status = String(order.status ?? '').toUpperCase();
        if (status !== 'FILLED' || !(executedQty > 0)) {
          return {
            orderId,
            status,
            executedQty,
            avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
            realizedProfit: null,
            realizedProfitCurrency: null,
          };
        }

        if (
          !Number.isFinite(Number(entryPrice)) ||
          !(Number(entryPrice) > 0) ||
          !entrySide
        ) {
          return null;
        }

        const realized = await this.getSpotOrderNetPnl(
          symbol,
          orderId,
          Number(entryPrice),
          entrySide,
          executedQty,
        );

        return {
          orderId,
          status,
          executedQty,
          avgPrice: Number.isFinite(avgPrice)
            ? avgPrice
            : (realized?.avgPrice ?? 0),
          realizedProfit: realized?.profit ?? null,
          realizedProfitCurrency: realized?.currency ?? null,
        };
      }

      const realized = await this.getFuturesOrderNetPnl(symbol, orderId);
      const recoveredAvgPrice =
        Number.isFinite(avgPrice) && avgPrice > 0
          ? avgPrice
          : realized?.avgPrice ?? null;
      return {
        orderId,
        status: String(order.status ?? '').toUpperCase(),
        executedQty,
        avgPrice: recoveredAvgPrice ?? 0,
        realizedProfit: realized?.profit ?? null,
        realizedProfitCurrency: realized?.currency ?? null,
      };
    } catch (e: any) {
      this.logger.warn(
        `[Binance] recoverOrderByClientId failed: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  private makeClientOrderId(operationKey: string): string {
    const digest = crypto
      .createHash('sha256')
      .update(operationKey)
      .digest('hex')
      .slice(0, 27);
    return `ta_${digest}`;
  }

  private makeProtectionClientOrderId(
    operationKey: string,
    kind: 'SL' | 'TP',
  ): string {
    const digest = crypto
      .createHash('sha256')
      .update(`PROTECTION:${kind}:${operationKey}`)
      .digest('hex')
      .slice(0, 27);
    const id = `ta${kind.toLowerCase()}_${digest}`;
    if (id.length > 32) {
      throw new Error(`Generated Binance protection clientOrderId exceeds 32 chars: ${id.length}`);
    }
    return id;
  }

  private makeOcoClientOrderId(
    operationKey: string,
    kind: 'LIST' | 'ABOVE' | 'BELOW',
  ): string {
    const digest = crypto
      .createHash('sha256')
      .update(`SPOT_OCO:${kind}:${operationKey}`)
      .digest('hex')
      .slice(0, 27);
    const id = `tao${kind === 'LIST' ? 'l' : kind === 'ABOVE' ? 'a' : 'b'}_${digest}`;
    if (id.length > 32) {
      throw new Error(`Generated Binance Spot OCO clientOrderId exceeds 32 chars: ${id.length}`);
    }
    return id;
  }

  private isBinanceOrderNotFoundError(error: any): boolean {
    const code = Number(error?.response?.data?.code);
    return code === -2011 || code === -2013;
  }

  private async getOrderByClientIdStrict(
    symbol: string,
    clientOrderId: string,
  ): Promise<any | null> {
    let order: any;
    try {
      order = await this.signedGet(
        this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
        { symbol, origClientOrderId: clientOrderId },
      );
    } catch (error: any) {
      if (this.isBinanceOrderNotFoundError(error)) return null;
      throw new Error(
        `Binance exact order lookup failed for ${symbol}/${clientOrderId}: ${String(error?.message ?? error)}`,
      );
    }

    if (!order || typeof order !== 'object') {
      throw new Error(`Binance exact order lookup returned invalid data for ${symbol}/${clientOrderId}`);
    }
    const actualClientOrderId = String(
      order.clientOrderId ?? order.origClientOrderId ?? '',
    );
    if (
      actualClientOrderId !== clientOrderId ||
      String(order.symbol ?? '').trim().toUpperCase() !== String(symbol).trim().toUpperCase()
    ) {
      throw new Error(`Binance exact order identity mismatch for ${symbol}/${clientOrderId}`);
    }
    return order;
  }

  private normalizeFuturesAlgoOrder(order: any): any {
    const clientAlgoId = String(order?.clientAlgoId ?? '');
    return {
      ...order,
      orderId: Number(order?.algoId),
      clientOrderId: clientAlgoId,
      origClientOrderId: clientAlgoId,
      status: String(order?.algoStatus ?? '').toUpperCase(),
      type: String(order?.orderType ?? '').toUpperCase(),
      stopPrice: order?.triggerPrice,
      origQty: order?.quantity,
      closePosition: order?.closePosition,
    };
  }

  private async getAlgoOrderByClientIdStrict(
    symbol: string,
    clientAlgoId: string,
  ): Promise<any | null> {
    let order: any;
    try {
      order = await this.signedGet('/fapi/v1/algoOrder', {
        symbol,
        clientAlgoId,
      });
    } catch (error: any) {
      if (this.isBinanceOrderNotFoundError(error)) return null;
      throw new Error(
        `Binance exact algo-order lookup failed for ${symbol}/${clientAlgoId}: ${String(error?.message ?? error)}`,
      );
    }

    if (!order || typeof order !== 'object') {
      throw new Error(`Binance exact algo-order lookup returned invalid data for ${symbol}/${clientAlgoId}`);
    }
    const orderSymbol = String(order.symbol ?? '').trim().toUpperCase();
    const actualClientAlgoId = String(order.clientAlgoId ?? '');
    const algoId = Number(order.algoId);
    if (
      actualClientAlgoId !== clientAlgoId ||
      orderSymbol !== String(symbol).trim().toUpperCase() ||
      !(algoId > 0) ||
      !Number.isFinite(algoId) ||
      String(order.algoType ?? '').toUpperCase() !== 'CONDITIONAL'
    ) {
      throw new Error(`Binance exact algo-order identity mismatch for ${symbol}/${clientAlgoId}`);
    }
    return this.normalizeFuturesAlgoOrder(order);
  }

  async getOpenAlgoOrders(symbol: string): Promise<any[]> {
    const response = await this.signedGet('/fapi/v1/openAlgoOrders', {
      symbol,
      algoType: 'CONDITIONAL',
    });
    if (!Array.isArray(response)) {
      throw new Error(`Binance open algo-order response is invalid for ${symbol}`);
    }

    return response.map((order: any) => {
      const normalized = this.normalizeFuturesAlgoOrder(order);
      if (
        String(normalized.symbol ?? '').trim().toUpperCase() !== String(symbol).trim().toUpperCase() ||
        !(normalized.orderId > 0) ||
        !Number.isFinite(normalized.orderId) ||
        !String(normalized.clientOrderId ?? '').trim() ||
        String(order.algoType ?? '').toUpperCase() !== 'CONDITIONAL'
      ) {
        throw new Error(`Binance open algo-order identity is invalid for ${symbol}`);
      }
      return normalized;
    });
  }

  private async getSpotOcoByClientIdStrict(
    symbol: string,
    listClientOrderId: string,
  ): Promise<any | null> {
    let list: any;
    try {
      list = await this.getSpotOcoByClientId(symbol, listClientOrderId);
    } catch (error: any) {
      if (this.isBinanceOrderNotFoundError(error)) return null;
      throw new Error(
        `Binance exact OCO lookup failed for ${symbol}/${listClientOrderId}: ${String(error?.message ?? error)}`,
      );
    }
    if (!list || typeof list !== 'object') {
      throw new Error(`Binance exact OCO lookup returned invalid data for ${symbol}/${listClientOrderId}`);
    }
    if (
      String(list.listClientOrderId ?? '') !== listClientOrderId ||
      (list.symbol != null &&
        String(list.symbol).trim().toUpperCase() !== String(symbol).trim().toUpperCase())
    ) {
      throw new Error(`Binance exact OCO identity mismatch for ${symbol}/${listClientOrderId}`);
    }
    return list;
  }

  async recoverOperationOrderForReconciliation(
    symbol: string,
    operationKey: string,
  ): Promise<any | null> {
    if (!operationKey || !operationKey.trim()) {
      throw new Error('Binance operation key is required for exact OPEN recovery');
    }
    return this.getOrderByClientIdStrict(
      symbol,
      this.makeClientOrderId(operationKey),
    );
  }

  private async cancelProtectionForEmergencyClose(
    signal: Signal,
    operationKey: string,
  ): Promise<void> {
    if (!operationKey || !operationKey.trim()) {
      throw new Error('Protection cleanup requires the original OPEN operation key');
    }
    const symbol = String(signal.symbol ?? '').trim().toUpperCase();
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    if (!symbol || !['BUY', 'SELL'].includes(signal.side)) {
      throw new Error('Protection cleanup received an invalid symbol or entry side');
    }

    const terminalOrderStatuses = new Set([
      'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH',
    ]);

    if (this.isFutures) {
      const protectionSpecs = [
        { kind: 'SL' as const, type: 'STOP_MARKET' },
        { kind: 'TP' as const, type: 'TAKE_PROFIT_MARKET' },
      ];
      const ownedAlgoIds = new Set<number>();

      for (const spec of protectionSpecs) {
        const clientAlgoId = this.makeProtectionClientOrderId(operationKey, spec.kind);
        const order = await this.getAlgoOrderByClientIdStrict(symbol, clientAlgoId);
        if (!order) continue;

        const algoId = Number(order.orderId);
        const status = String(order.status ?? '').trim().toUpperCase();
        if (
          !(algoId > 0) || !Number.isFinite(algoId) ||
          String(order.symbol ?? '').trim().toUpperCase() !== symbol ||
          String(order.clientOrderId ?? '') !== clientAlgoId ||
          String(order.side ?? '').trim().toUpperCase() !== closeSide ||
          String(order.type ?? '').trim().toUpperCase() !== spec.type ||
          String(order.closePosition).trim().toLowerCase() !== 'true'
        ) {
          throw new Error(
            `Operation-owned Binance Futures ${spec.kind} algo-order identity/shape mismatch for ${symbol}; refusing market close`,
          );
        }

        ownedAlgoIds.add(algoId);
        if (status === 'FILLED' || status === 'PARTIALLY_FILLED' || status === 'TRIGGERED' || status === 'FINISHED') {
          throw new Error(
            `Operation-owned Binance Futures ${spec.kind} algo-order is ${status} for ${symbol}; position may already have changed`,
          );
        }
        if (terminalOrderStatuses.has(status)) continue;
        if (status !== 'NEW') {
          throw new Error(
            `Operation-owned Binance Futures ${spec.kind} algo-order has unsupported status=${status || 'UNKNOWN'} for ${symbol}`,
          );
        }

        let cancelResponse: any = null;
        try {
          cancelResponse = await this.signedDelete('/fapi/v1/algoOrder', {
            symbol,
            algoId,
          });
        } catch (cancelError: any) {
          const afterError = await this.getAlgoOrderByClientIdStrict(symbol, clientAlgoId);
          const afterErrorStatus = String(afterError?.status ?? '').trim().toUpperCase();
          if (!afterError || !terminalOrderStatuses.has(afterErrorStatus)) {
            throw new Error(
              `Binance Futures ${spec.kind} algo-order cancellation is ambiguous for ${symbol}/${clientAlgoId}: ${String(cancelError?.message ?? cancelError)}`,
            );
          }
        }

        if (cancelResponse) {
          const returnedId = Number(cancelResponse.algoId);
          const returnedClientAlgoId = String(cancelResponse.clientAlgoId ?? '');
          if (
            (Number.isFinite(returnedId) && returnedId > 0 && returnedId !== algoId) ||
            (returnedClientAlgoId && returnedClientAlgoId !== clientAlgoId)
          ) {
            throw new Error(
              `Binance Futures ${spec.kind} algo-order cancellation identity mismatch for ${symbol}`,
            );
          }
        }

        const confirmed = await this.getAlgoOrderByClientIdStrict(symbol, clientAlgoId);
        const confirmedStatus = String(confirmed?.status ?? '').trim().toUpperCase();
        if (
          !confirmed ||
          confirmedStatus === 'FILLED' ||
          confirmedStatus === 'PARTIALLY_FILLED' ||
          confirmedStatus === 'TRIGGERED' ||
          confirmedStatus === 'FINISHED' ||
          !terminalOrderStatuses.has(confirmedStatus)
        ) {
          throw new Error(
            `Binance Futures ${spec.kind} algo-order cancellation could not be authoritatively confirmed for ${symbol}`,
          );
        }
      }

      const openAlgoOrders = await this.getOpenAlgoOrders(symbol);
      const liveOwned = openAlgoOrders.filter((order: any) => {
        const clientId = String(order.clientOrderId ?? '');
        const algoId = Number(order.orderId);
        return (
          ownedAlgoIds.has(algoId) ||
          clientId === this.makeProtectionClientOrderId(operationKey, 'SL') ||
          clientId === this.makeProtectionClientOrderId(operationKey, 'TP')
        );
      });
      if (liveOwned.length > 0) {
        throw new Error(`Operation-owned Binance Futures algo protection is still open for ${symbol}`);
      }
      if (openAlgoOrders.length > 0) {
        const outstanding = openAlgoOrders.map((order: any) =>
          String(order.clientOrderId ?? order.orderId ?? 'unknown'),
        ).join(',');
        throw new Error(
          `Unrelated Binance Futures algo orders remain open for ${symbol} (${outstanding}); they were not canceled and emergency close is blocked`,
        );
      }

      const openOrders = await this.getOpenOrders(symbol);
      if (openOrders.length > 0) {
        const outstanding = openOrders.map((order: any) =>
          String(order.clientOrderId ?? order.origClientOrderId ?? order.orderId ?? 'unknown'),
        ).join(',');
        throw new Error(
          `Unrelated Binance Futures regular orders remain open for ${symbol} (${outstanding}); they were not canceled and emergency close is blocked`,
        );
      }
      return;
    }

        const listClientOrderId = this.makeOcoClientOrderId(operationKey, 'LIST');
    const list = await this.getSpotOcoByClientIdStrict(symbol, listClientOrderId);
    if (list) {
      const listStatus = String(list.listStatusType ?? '').trim().toUpperCase();
      const orderStatus = String(list.listOrderStatus ?? '').trim().toUpperCase();
      const active =
        ['EXEC_STARTED', 'EXECUTING'].includes(listStatus) ||
        orderStatus === 'EXECUTING';
      const terminalList = ['ALL_DONE', 'REJECT', 'REJECTED'].includes(listStatus) ||
        ['ALL_DONE', 'REJECT', 'REJECTED'].includes(orderStatus);
      if (active) {
        await this.cancelSpotProtectionByOperation(symbol, operationKey);
      } else if (!terminalList) {
        throw new Error(
          `Binance Spot OCO status is ambiguous for ${symbol}: ${listStatus}/${orderStatus}`,
        );
      }
    }

    for (const kind of ['ABOVE', 'BELOW'] as const) {
      const clientOrderId = this.makeOcoClientOrderId(operationKey, kind);
      const order = await this.getOrderByClientIdStrict(symbol, clientOrderId);
      if (!order) continue;
      const status = String(order.status ?? '').trim().toUpperCase();
      const expectedType = kind === 'ABOVE' ? 'LIMIT_MAKER' : 'STOP_LOSS_LIMIT';
      if (
        String(order.clientOrderId ?? order.origClientOrderId ?? '') !== clientOrderId ||
        String(order.symbol ?? '').trim().toUpperCase() !== symbol ||
        String(order.side ?? '').trim().toUpperCase() !== closeSide ||
        String(order.type ?? '').trim().toUpperCase() !== expectedType
      ) {
        throw new Error(
          `Operation-owned Binance Spot OCO leg identity/shape mismatch for ${symbol}; refusing market close`,
        );
      }
      if (
        status === 'FILLED' ||
        status === 'PARTIALLY_FILLED' ||
        status === 'NEW' ||
        !terminalOrderStatuses.has(status)
      ) {
        throw new Error(
          `Operation-owned Binance Spot OCO leg ${clientOrderId} remains active or ambiguous (status=${status || 'UNKNOWN'})`,
        );
      }
    }

    const openOrders = await this.getOpenOrders(symbol);
    if (openOrders.length > 0) {
      const outstanding = openOrders.map((order: any) =>
        String(order.clientOrderId ?? order.origClientOrderId ?? order.orderId ?? 'unknown'),
      ).join(',');
      throw new Error(
        `Binance Spot orders remain open for ${symbol} (${outstanding}); they were not canceled and emergency close is blocked`,
      );
    }
  }

  private async findOrderByClientId(symbol: string, clientOrderId: string): Promise<any | null> {
    try {
      return await this.signedGet(
        this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
        this.isFutures
          ? { symbol, origClientOrderId: clientOrderId }
          : { symbol, origClientOrderId: clientOrderId },
      );
    } catch {
      return null;
    }
  }

  // ─── Ping ──────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.http.get(this.isFutures ? '/fapi/v1/ping' : '/api/v3/ping');
      if (this.isFutures) {
        const mode = await this.signedGet('/fapi/v1/positionSide/dual', {});
        if (mode?.dualSidePosition === true) {
          throw new Error('Binance hedge/dual-side position mode is not supported; configure one-way mode');
        }
      }
      return true;
    } catch { return false; }
  }

  // ─── Place Order with SL/TP ────────────────────────────────────────────

  async placeMarketOrder(signal: Signal, quantity: number, clientOrderId?: string, operationKey?: string): Promise<Trade | null> {
    if (this.db && (!clientOrderId?.trim() || !operationKey?.trim())) {
      this.logger.error('Binance entry blocked: durable execution identity is required for recovery');
      return null;
    }
    const spec = getSymbolSpec(signal.symbol);
    if (!this.isFutures && signal.side === 'SELL') {
      this.logger.error(`[Binance Spot] SELL/short semantics are unsupported by this executor; trade blocked`);
      return null;
    }
    let emergencyCloseAttempted = false;
    try {
      // 1. Market entry order
      const entry = await this.signedPost(
        this.isFutures ? '/fapi/v1/order' : '/api/v3/order',
        {
          symbol:   signal.symbol,
          side:     signal.side,
          type:     'MARKET',
          quantity: this.formatQty(quantity, spec.volumeStep),
          ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
        }
      );

      let fillPrice = Number(entry.avgPrice ?? entry.fills?.[0]?.price ?? 0);
      const executedQty = Number(entry.executedQty ?? entry.origQty ?? quantity);
      const ticket = Number(entry.orderId);
      let entryCommission = 0;
      let entryCommissionCurrency: string | undefined;
      if (!this.isFutures) {
        const summary = await this.getSpotOrderFillSummary(
          signal.symbol,
          ticket,
          executedQty,
        );
        if (!summary) {
          throw new Error(
            `Binance Spot entry fills/commission could not be verified for ${signal.symbol}`
          );
        }
        fillPrice = summary.avgPrice;
        entryCommission = summary.feeQuote;
        entryCommissionCurrency = summary.currency;
      } else {
        const summary = await this.getFuturesOrderFillSummary(
          signal.symbol,
          ticket,
          executedQty,
        );
        if (!summary) {
          throw new Error(
            `Binance Futures entry fills/commission could not be verified for ${signal.symbol}`
          );
        }
        fillPrice = summary.avgPrice;
        entryCommission = summary.commission;
        entryCommissionCurrency = summary.currency;
      }
      if (!(fillPrice > 0) || !Number.isFinite(fillPrice)) {
        throw new Error('Binance order returned invalid fill price');
      }
      if (!(executedQty > 0) || !Number.isFinite(executedQty)) {
        throw new Error('Binance order returned invalid executed quantity');
      }

      this.logger.info(
        `[Binance] Entry: ${signal.side} ${quantity} ${signal.symbol} ` +
        `@ ${fillPrice} ticket=${ticket}`
      );

      // 2. Protective orders are fail-safe: the trade is NOT accepted unless
      //    SL+TP (or Spot OCO) are confirmed. If protection fails, attempt an
      //    immediate market close so we never knowingly continue unprotected.
      try {
        if (this.isFutures) {
          await this.placeSLTP(signal, executedQty, ticket, spec, operationKey);
        } else {
          await this.placeOCO(
            signal,
            executedQty,
            ticket,
            spec,
            operationKey,
          );
        }
      } catch (protectionError: any) {
        this.logger.error(`CRITICAL: protective orders failed for ${signal.symbol}: ${protectionError?.message ?? protectionError}`);
        emergencyCloseAttempted = true;
        const emergencyError = await this.emergencyCloseAfterProtectionFailure(
          signal,
          executedQty,
          operationKey,
          clientOrderId,
          {
            orderId: ticket,
            entryPrice: fillPrice,
            executedQty,
            commission: entryCommission,
            commissionCurrency: entryCommissionCurrency ?? null,
          },
          String(protectionError?.message ?? protectionError),
        ).catch(e => e);
        if (emergencyError) throw new Error(`Protection failed and emergency close failed for ${signal.symbol}`);
        if (this.isFutures) {
          const remaining = await this.getPosition(signal.symbol);
          if (remaining && Math.abs(remaining.positionAmt) > 0)
            throw new Error(`Protection failed and position remains open for ${signal.symbol}`);
        }
        return null;
      }

      return {
        ticket,
        symbol: signal.symbol,
        side: signal.side,
        volume: executedQty,
        entry: fillPrice,
        sl: signal.sl,
        tp: signal.tp,
        status: 'open',
        openedAt: Date.now(),
        source: signal.source,
        ...(entryCommission > 0
          ? {
              commission: entryCommission,
              commissionCurrency: entryCommissionCurrency,
            }
          : {}),
      };

    } catch (e: any) {
      if (emergencyCloseAttempted) {
        this.logger.error('Emergency-close recovery required; refusing to retry entry/protection flow: ' + String(e?.message ?? e));
        return null;
      }
      if (clientOrderId) {
        const recovered = await this.findOrderByClientId(signal.symbol, clientOrderId);
        if (recovered && !['CANCELED','REJECTED','EXPIRED'].includes(String(recovered.status ?? '').toUpperCase())) {
          const recoveredTicket = Number(recovered.orderId);
          const executedQtyRecovered = Number(
            recovered.executedQty ?? recovered.origQty ?? quantity,
          );
          let fillPriceRecovered = Number(
            recovered.avgPrice ?? recovered.fills?.[0]?.price ?? 0,
          );
          let entryCommissionRecovered = 0;
          let entryCommissionCurrencyRecovered: string | undefined;
          try {
            const summary = this.isFutures
              ? await this.getFuturesOrderFillSummary(
                  signal.symbol,
                  recoveredTicket,
                  executedQtyRecovered,
                )
              : await this.getSpotOrderFillSummary(
                  signal.symbol,
                  recoveredTicket,
                  executedQtyRecovered,
                );
            if (!summary) {
              throw new Error(
                this.isFutures
                  ? 'Futures entry fill summary unavailable'
                  : 'Spot entry fill summary unavailable',
              );
            }
            fillPriceRecovered = summary.avgPrice;
            entryCommissionRecovered = 'commission' in summary
              ? summary.commission
              : summary.feeQuote;
            entryCommissionCurrencyRecovered = summary.currency;
          } catch (summaryError: any) {
              emergencyCloseAttempted = true;
              const emergencyError = await this.emergencyCloseAfterProtectionFailure(
                signal,
                executedQtyRecovered,
                operationKey,
                clientOrderId,
                {
                  orderId: recoveredTicket,
                  entryPrice: fillPriceRecovered,
                  executedQty: executedQtyRecovered,
                  commission: null,
                  commissionCurrency: null,
                },
                String(summaryError?.message ?? summaryError),
              ).catch(e => e);
              if (emergencyError) {
                throw new Error(
                  `Recovered Binance entry accounting failed and emergency close failed: ${summaryError?.message ?? summaryError}`,
                );
              }
              return null;
            }
          if (!(fillPriceRecovered > 0) || !Number.isFinite(fillPriceRecovered)) {
            throw new Error('Recovered Binance order returned invalid fill price');
          }
          if (!(executedQtyRecovered > 0) || !Number.isFinite(executedQtyRecovered)) {
            throw new Error('Recovered Binance order returned invalid executed quantity');
          }
          this.logger.warn(`[Binance] Recovered ambiguous order ${clientOrderId} as ticket=${recoveredTicket}`);
          try {
            if (this.isFutures) await this.placeSLTP(
              signal,
              executedQtyRecovered,
              recoveredTicket,
              getSymbolSpec(signal.symbol),
              operationKey,
            );
            else await this.placeOCO(
              signal,
              executedQtyRecovered,
              recoveredTicket,
              getSymbolSpec(signal.symbol),
              operationKey,
            );
          } catch (protectionError: any) {
            emergencyCloseAttempted = true;
            const emergencyError = await this.emergencyCloseAfterProtectionFailure(
              signal,
              executedQtyRecovered,
              operationKey,
              clientOrderId,
              {
                orderId: recoveredTicket,
                entryPrice: fillPriceRecovered,
                executedQty: executedQtyRecovered,
                commission: entryCommissionRecovered,
                commissionCurrency: entryCommissionCurrencyRecovered ?? null,
              },
              String(protectionError?.message ?? protectionError),
            ).catch(e => e);
            if (emergencyError) throw new Error(`Recovered order protection failed and emergency close failed: ${protectionError?.message ?? protectionError}`);
            if (this.isFutures) {
              const remaining = await this.getPosition(signal.symbol);
              if (remaining && Math.abs(remaining.positionAmt) > 0) throw new Error(`Recovered order remained unprotected: ${signal.symbol}`);
            }
            return null;
          }
          return {
            ticket: recoveredTicket,
            symbol: signal.symbol,
            side: signal.side,
            volume: executedQtyRecovered,
            entry: fillPriceRecovered,
            sl: signal.sl,
            tp: signal.tp,
            status: 'open',
            openedAt: Date.now(),
            source: signal.source,
            ...(entryCommissionRecovered > 0
              ? {
                  commission: entryCommissionRecovered,
                  commissionCurrency: entryCommissionCurrencyRecovered,
                }
              : {}),
          };
        }
      }
      this.logger.error(`placeMarketOrder failed: ${e.response?.data ?? e.message}`);
      return null;
    }
  }

  // ─── [FIX-1] Futures SL + TP orders ──────────────────────────────────

  private validateFuturesProtectionPair(
    signal: Signal,
    quantity: number,
    slPrice: string,
    tpPrice: string,
    recovered: { sl: any | null; tp: any | null },
  ): { slOrderId: number; tpOrderId: number } | null {
    const sl = recovered?.sl;
    const tp = recovered?.tp;
    if (!sl || !tp) return null;

    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const expectedQty = Number(quantity);

    // closePosition Algo orders intentionally omit quantity at the broker.
    // Their identity, side, type, status and trigger prices are validated below.
    if (
      !(expectedQty > 0) ||
      !Number.isFinite(expectedQty)
    ) {
      return null;
    }

    if (
      String(sl.status ?? '').toUpperCase() !== 'NEW' ||
      String(tp.status ?? '').toUpperCase() !== 'NEW' ||
      String(sl.side ?? '').toUpperCase() !== closeSide ||
      String(tp.side ?? '').toUpperCase() !== closeSide ||
      String(sl.type ?? '').toUpperCase() !== 'STOP_MARKET' ||
      String(tp.type ?? '').toUpperCase() !== 'TAKE_PROFIT_MARKET' ||
      String(sl.closePosition).toLowerCase() !== 'true' ||
      String(tp.closePosition).toLowerCase() !== 'true'
    ) {
      return null;
    }

    const slTolerance = Math.max(1e-8, Math.abs(Number(signal.sl)) * 1e-6);
    const tpTolerance = Math.max(1e-8, Math.abs(Number(signal.tp)) * 1e-6);
    if (
      !Number.isFinite(Number(sl.stopPrice)) ||
      !Number.isFinite(Number(tp.stopPrice)) ||
      Math.abs(Number(sl.stopPrice) - Number(signal.sl)) > slTolerance ||
      Math.abs(Number(tp.stopPrice) - Number(signal.tp)) > tpTolerance
    ) {
      return null;
    }

    const slOrderId = Number(sl.orderId);
    const tpOrderId = Number(tp.orderId);
    if (
      !(slOrderId > 0) ||
      !(tpOrderId > 0) ||
      !Number.isFinite(slOrderId) ||
      !Number.isFinite(tpOrderId)
    ) {
      return null;
    }

    return { slOrderId, tpOrderId };
  }

  private async placeSLTP(
    signal:   Signal,
    quantity: number,
    ticket:   number,
    spec:     ReturnType<typeof getSymbolSpec>,
    protectionKey?: string,
  ): Promise<void> {
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const qty       = this.formatQty(quantity, spec.volumeStep);
    const slPrice   = this.formatPrice(signal.sl, spec.pip);
    const tpPrice   = this.formatPrice(signal.tp, spec.pip);

    if (protectionKey) {
      const recovered = await this.recoverProtectionByOperation(
        signal.symbol,
        protectionKey,
      );
      const recoveredIds = this.validateFuturesProtectionPair(
        signal,
        quantity,
        slPrice,
        tpPrice,
        recovered,
      );
      if (recoveredIds) {
        this.orderMap.set(ticket, {
          slOrderId: recoveredIds.slOrderId,
          tpOrderId: recoveredIds.tpOrderId,
          closeSide,
          quantity,
        });
        this.logger.info(
          `[Binance] Recovered existing SL/TP before create: ${signal.symbol} ticket=${ticket}`,
        );
        return;
      }
    }

    const ids: OpenOrderIds = {};
    const slClientOrderId = protectionKey
      ? this.makeProtectionClientOrderId(protectionKey, 'SL')
      : undefined;
    const tpClientOrderId = protectionKey
      ? this.makeProtectionClientOrderId(protectionKey, 'TP')
      : undefined;

    try {
      const slOrder = await this.signedPost('/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol:           signal.symbol,
        side:             closeSide,
        type:             'STOP_MARKET',
        triggerPrice:     slPrice,
        closePosition:    'true',
        workingType:      'MARK_PRICE',
        ...(slClientOrderId ? { clientAlgoId: slClientOrderId } : {}),
      });
      ids.slOrderId = Number(slOrder.algoId);
      if (
        !(ids.slOrderId > 0) ||
        !Number.isFinite(ids.slOrderId) ||
        (slClientOrderId && String(slOrder.clientAlgoId ?? '') !== slClientOrderId) ||
        (slOrder.symbol && String(slOrder.symbol).trim().toUpperCase() !== String(signal.symbol).trim().toUpperCase())
      ) {
        throw new Error('Binance SL algo placement returned invalid identity');
      }
      this.logger.info(
        `[Binance] SL algo placed: ${signal.symbol} triggerPrice=${slPrice} algoId=${ids.slOrderId}`,
      );
    } catch (e: any) {
      if (protectionKey) {
        const recovered = await this.recoverProtectionByOperation(
          signal.symbol,
          protectionKey,
        );
        const recoveredIds = this.validateFuturesProtectionPair(
          signal,
          quantity,
          slPrice,
          tpPrice,
          recovered,
        );
        if (recoveredIds) {
          this.orderMap.set(ticket, {
            slOrderId: recoveredIds.slOrderId,
            tpOrderId: recoveredIds.tpOrderId,
            closeSide,
            quantity,
          });
          return;
        }
      }
      const brokerCode = e?.response?.data?.code;
      const brokerMessage = e?.response?.data?.msg ?? e?.message ?? String(e);
      throw new Error(
        `SL placement failed${brokerCode != null ? ` code=${brokerCode}` : ''}: ${brokerMessage}`,
      );
    }

    try {
      const tpOrder = await this.signedPost('/fapi/v1/algoOrder', {
        algoType: 'CONDITIONAL',
        symbol:           signal.symbol,
        side:             closeSide,
        type:             'TAKE_PROFIT_MARKET',
        triggerPrice:     tpPrice,
        closePosition:    'true',
        workingType:      'MARK_PRICE',
        ...(tpClientOrderId ? { clientAlgoId: tpClientOrderId } : {}),
      });
      ids.tpOrderId = Number(tpOrder.algoId);
      if (
        !(ids.tpOrderId > 0) ||
        !Number.isFinite(ids.tpOrderId) ||
        (tpClientOrderId && String(tpOrder.clientAlgoId ?? '') !== tpClientOrderId) ||
        (tpOrder.symbol && String(tpOrder.symbol).trim().toUpperCase() !== String(signal.symbol).trim().toUpperCase())
      ) {
        throw new Error('Binance TP algo placement returned invalid identity');
      }
      this.logger.info(
        `[Binance] TP algo placed: ${signal.symbol} triggerPrice=${tpPrice} algoId=${ids.tpOrderId}`,
      );
    } catch (e: any) {
      if (protectionKey) {
        const recovered = await this.recoverProtectionByOperation(
          signal.symbol,
          protectionKey,
        );
        const recoveredIds = this.validateFuturesProtectionPair(
          signal,
          quantity,
          slPrice,
          tpPrice,
          recovered,
        );
        if (recoveredIds) {
          this.orderMap.set(ticket, {
            slOrderId: recoveredIds.slOrderId,
            tpOrderId: recoveredIds.tpOrderId,
            closeSide,
            quantity,
          });
          return;
        }
      }

      if (ids.slOrderId) {
        await this.signedDelete('/fapi/v1/algoOrder', {
          symbol: signal.symbol,
          algoId: ids.slOrderId,
        }).catch(() => {});
      }
      const brokerCode = e?.response?.data?.code;
      const brokerMessage = e?.response?.data?.msg ?? e?.message ?? String(e);
      throw new Error(
        `TP placement failed${brokerCode != null ? ` code=${brokerCode}` : ''}: ${brokerMessage}`,
      );
    }

    if (protectionKey) {
      const confirmed = await this.recoverProtectionByOperation(
        signal.symbol,
        protectionKey,
      );
      const confirmedIds = this.validateFuturesProtectionPair(
        signal,
        quantity,
        slPrice,
        tpPrice,
        confirmed,
      );
      if (!confirmedIds) {
        throw new Error(
          `Binance SL/TP created but final protection state could not be verified for ${signal.symbol}`,
        );
      }
      ids.slOrderId = confirmedIds.slOrderId;
      ids.tpOrderId = confirmedIds.tpOrderId;
    }

    ids.closeSide = closeSide;
    ids.quantity = quantity;
    this.orderMap.set(ticket, ids);
  }

  // ─── Spot OCO (SL + TP combined) ─────────────────────────────────────

  private async verifySpotOcoOpenLegs(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    sl: number,
    tp: number,
    orderIds: { slOrderId: number; tpOrderId: number },
    volumeStep: number,
  ): Promise<boolean> {
    const openOrders = await this.getOpenOrders(symbol);
    const byId = new Map(openOrders.map((order: any) => [Number(order.orderId), order]));
    const slOrder = byId.get(orderIds.slOrderId);
    const tpOrder = byId.get(orderIds.tpOrderId);
    if (!slOrder || !tpOrder) return false;

    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    const tolerance = (target: number) => Math.max(1e-8, Math.abs(target) * 1e-6);
    const qtyTolerance = Math.max(volumeStep, Math.abs(quantity) * 0.0001);
    const slQty = Number(slOrder.origQty ?? slOrder.quantity);
    const tpQty = Number(tpOrder.origQty ?? tpOrder.quantity);

    return (
      String(slOrder.symbol ?? '').toUpperCase() === String(symbol).toUpperCase() &&
      String(tpOrder.symbol ?? '').toUpperCase() === String(symbol).toUpperCase() &&
      String(slOrder.side ?? '').toUpperCase() === closeSide &&
      String(tpOrder.side ?? '').toUpperCase() === closeSide &&
      String(slOrder.type ?? '').toUpperCase() === 'STOP_LOSS_LIMIT' &&
      String(tpOrder.type ?? '').toUpperCase() === 'LIMIT_MAKER' &&
      String(slOrder.status ?? '').toUpperCase() === 'NEW' &&
      String(tpOrder.status ?? '').toUpperCase() === 'NEW' &&
      Number.isFinite(slQty) &&
      Number.isFinite(tpQty) &&
      Math.abs(slQty - quantity) <= qtyTolerance &&
      Math.abs(tpQty - quantity) <= qtyTolerance &&
      Number.isFinite(Number(slOrder.stopPrice)) &&
      Number.isFinite(Number(tpOrder.price)) &&
      Math.abs(Number(slOrder.stopPrice) - sl) <= tolerance(sl) &&
      Math.abs(Number(tpOrder.price) - tp) <= tolerance(tp)
    );
  }

  private async placeOCO(
    signal:       Signal,
    quantity:     number,
    ticket:       number,
    spec:         ReturnType<typeof getSymbolSpec>,
    protectionKey?: string,
  ): Promise<void> {
    const closeSide = signal.side === 'BUY' ? 'SELL' : 'BUY';

    const tpPrice = this.formatPrice(signal.tp, spec.pip);
    const slPrice = this.formatPrice(signal.sl, spec.pip);
    const slLimit = signal.side === 'BUY'
      ? this.formatPrice(signal.sl * 0.9995, spec.pip)
      : this.formatPrice(signal.sl * 1.0005, spec.pip);

    const listClientOrderId = protectionKey
      ? this.makeOcoClientOrderId(protectionKey, 'LIST')
      : `tao_${ticket}`;
    const aboveClientOrderId = protectionKey
      ? this.makeOcoClientOrderId(protectionKey, 'ABOVE')
      : `taa_${ticket}`;
    const belowClientOrderId = protectionKey
      ? this.makeOcoClientOrderId(protectionKey, 'BELOW')
      : `tab_${ticket}`;

    const validateOco = (oco: any): {
      listId: number;
      slOrderId: number;
      tpOrderId: number;
    } => {
      const status = String(oco?.listStatusType ?? '').toUpperCase();
      const listStatus = String(oco?.listOrderStatus ?? '').toUpperCase();
      if (
        !['EXEC_STARTED', 'EXECUTING'].includes(status) &&
        !['EXECUTING'].includes(listStatus)
      ) {
        throw new Error(
          `Binance Spot OCO list is not an active protection state: status=${status} listStatus=${listStatus}`,
        );
      }

      const returnedListId = String(oco?.listClientOrderId ?? '');
      if (returnedListId !== listClientOrderId) {
        throw new Error(
          `Binance Spot OCO identity mismatch: expected=${listClientOrderId} got=${returnedListId}`,
        );
      }

      const reports = Array.isArray(oco?.orderReports)
        ? oco.orderReports
        : [];
      const listedOrders = Array.isArray(oco?.orders)
        ? oco.orders
        : [];
      const legs = reports.length >= 2 ? reports : listedOrders;
      if (legs.length < 2) {
        throw new Error('Binance Spot OCO requires two order legs');
      }

      const findLeg = (clientId: string, fallbackType: string) =>
        legs.find(
          (r: any) =>
            Number(r.orderId) > 0 &&
            (
              String(r.clientOrderId ?? '') === clientId ||
              String(r.type ?? '').toUpperCase() === fallbackType
            ),
        );

      const tpReport = findLeg(aboveClientOrderId, 'LIMIT_MAKER');
      const slReport = findLeg(belowClientOrderId, 'STOP_LOSS_LIMIT');
      if (!tpReport || !slReport) {
        throw new Error('Binance Spot OCO legs could not be identified');
      }

      if (
        reports.length >= 2 &&
        (
          String(tpReport.side ?? '').toUpperCase() !== closeSide ||
          String(slReport.side ?? '').toUpperCase() !== closeSide
        )
      ) {
        throw new Error('Binance Spot OCO protection legs have an unexpected side');
      }

      const expectedQty = Number(quantity);
      const tpQty = Number(tpReport.origQty ?? tpReport.quantity ?? expectedQty);
      const slQty = Number(slReport.origQty ?? slReport.quantity ?? expectedQty);
      if (
        !(expectedQty > 0) ||
        !Number.isFinite(expectedQty) ||
        !Number.isFinite(tpQty) ||
        !Number.isFinite(slQty) ||
        Math.abs(tpQty - expectedQty) > Math.max(spec.volumeStep, expectedQty * 0.0001) ||
        Math.abs(slQty - expectedQty) > Math.max(spec.volumeStep, expectedQty * 0.0001)
      ) {
        throw new Error('Binance Spot OCO leg quantities do not match the executed entry quantity');
      }

      const tpId = Number(tpReport.orderId);
      const slId = Number(slReport.orderId);
      const listId = Number(oco.orderListId);
      if (
        !(tpId > 0) ||
        !(slId > 0) ||
        !(listId > 0) ||
        !Number.isFinite(tpId) ||
        !Number.isFinite(slId) ||
        !Number.isFinite(listId)
      ) {
        throw new Error('Binance Spot OCO returned invalid order/list identities');
      }

      return {
        listId,
        tpOrderId: tpId,
        slOrderId: slId,
      };
    };

    // After a timeout, the OCO request may have reached Binance even when the
    // client never received the response. Recover the exact list before
    // creating anything new.
    if (protectionKey) {
      const recovered = await this.getSpotOcoByClientId(
        signal.symbol,
        listClientOrderId,
      ).catch(() => null);
      if (recovered) {
        const ids = validateOco(recovered);
        const verified = await this.verifySpotOcoOpenLegs(
          signal.symbol,
          signal.side,
          quantity,
          signal.sl,
          signal.tp,
          ids,
          spec.volumeStep,
        );
        if (!verified) {
          throw new Error(
            `Binance Spot OCO list exists but active legs are not both valid for ${signal.symbol}`,
          );
        }
        this.orderMap.set(ticket, {
          slOrderId: ids.slOrderId,
          tpOrderId: ids.tpOrderId,
          orderListId: ids.listId,
          closeSide,
          quantity,
        });
        return;
      }
    }

    let oco: any;
    try {
      oco = await this.signedPost('/api/v3/orderList/oco', {
        symbol:             signal.symbol,
        side:               closeSide,
        quantity:           this.formatQty(quantity, spec.volumeStep),
        listClientOrderId,
        aboveClientOrderId,
        belowClientOrderId,
        aboveType:           'LIMIT_MAKER',
        abovePrice:          tpPrice,
        belowType:           'STOP_LOSS_LIMIT',
        belowStopPrice:      slPrice,
        belowPrice:          slLimit,
        belowTimeInForce:    'GTC',
      });
    } catch (e: any) {
      if (protectionKey) {
        const recovered = await this.getSpotOcoByClientId(
          signal.symbol,
          listClientOrderId,
        ).catch(() => null);
        if (recovered) {
          const ids = validateOco(recovered);
          if (!(await this.verifySpotOcoOpenLegs(
            signal.symbol,
            signal.side,
            quantity,
            signal.sl,
            signal.tp,
            ids,
            spec.volumeStep,
          ))) {
            throw new Error(
              `Recovered Binance Spot OCO legs are not both valid for ${signal.symbol}`,
            );
          }
          this.orderMap.set(ticket, {
            slOrderId: ids.slOrderId,
            tpOrderId: ids.tpOrderId,
            orderListId: ids.listId,
            closeSide,
            quantity,
          });
          return;
        }
      }
      throw new Error(
        `Binance Spot OCO placement failed: ${e?.response?.data?.msg ?? e?.message ?? e}`,
      );
    }

    let ids: { listId: number; slOrderId: number; tpOrderId: number };
    try {
      ids = validateOco(oco);
    } catch (validationError) {
      if (protectionKey) {
        const recovered = await this.getSpotOcoByClientId(
          signal.symbol,
          listClientOrderId,
        ).catch(() => null);
        if (recovered) {
          ids = validateOco(recovered);
        } else {
          throw validationError;
        }
      } else {
        throw validationError;
      }
    }

    this.orderMap.set(ticket, {
      slOrderId: ids.slOrderId,
      tpOrderId: ids.tpOrderId,
      orderListId: ids.listId,
      closeSide,
      quantity,
    });

    this.logger.info(
      `[Binance Spot] OCO placed/recovered: ${signal.symbol} TP=${tpPrice} SL=${slPrice} list=${ids.listId}`,
    );
  }

  // ─── Modify SL/TP ─────────────────────────────────────────────────────

  private async cancelSpotProtectionByOperation(
    symbol: string,
    operationKey: string,
  ): Promise<void> {
    const list = await this.recoverSpotOcoByOperation(symbol, operationKey);
    if (!list) {
      throw new Error(
        `Binance Spot OCO could not be recovered before closing ${symbol}`,
      );
    }

    const status = String(list.listStatusType).toUpperCase();
    const listStatus = String(list.listOrderStatus).toUpperCase();
    if (
      !['EXEC_STARTED', 'EXECUTING'].includes(status) &&
      !['EXECUTING'].includes(listStatus)
    ) {
      throw new Error(
        `Binance Spot OCO is not active before close for ${symbol}: ${status}/${listStatus}`,
      );
    }

    const listClientOrderId = this.makeOcoClientOrderId(operationKey, 'LIST');
    const listId = Number(list.orderListId);
    if (!(listId > 0) || !Number.isFinite(listId)) {
      throw new Error(
        `Binance Spot OCO has invalid orderListId before close for ${symbol}`,
      );
    }

    let cancelResponse: any;
    try {
      cancelResponse = await this.signedDelete('/api/v3/orderList', {
        symbol,
        orderListId: listId,
      });
    } catch {
      // A timeout can happen after Binance accepted the cancellation. Query
      // the same order list before deciding that cancellation failed.
      cancelResponse = null;
    }

    if (
      cancelResponse &&
      String(cancelResponse?.listClientOrderId ?? '') !== listClientOrderId
    ) {
      throw new Error(
        `Binance Spot OCO cancellation identity mismatch for ${symbol}`,
      );
    }

    const after = await this.getSpotOcoByClientId(
      symbol,
      listClientOrderId,
    );
    if (!after) {
      // Some deployments do not return an order list once it is finished.
      const openOrders = await this.getOpenOrders(symbol);
      const liveIds = new Set(
        (Array.isArray(list.orders) ? list.orders : [])
          .map((order: any) => Number(order.orderId))
          .filter((id: number) => Number.isFinite(id) && id > 0),
      );
      if (
        [...liveIds].some(id =>
          openOrders.some((order: any) => Number(order.orderId) === id),
        )
      ) {
        throw new Error(
          `Binance Spot OCO cancellation could not be verified for ${symbol}`,
        );
      }
      return;
    }

    const finalStatus = String(after.listStatusType ?? '').toUpperCase();
    const finalOrderStatus = String(after.listOrderStatus ?? '').toUpperCase();
    if (
      finalStatus !== 'ALL_DONE' &&
      finalOrderStatus !== 'ALL_DONE'
    ) {
      throw new Error(
        `Binance Spot OCO cancellation not complete for ${symbol}: ${finalStatus}/${finalOrderStatus}`,
      );
    }

    const orderIds = (Array.isArray(list.orders) ? list.orders : [])
      .map((order: any) => Number(order.orderId))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    if (!orderIds.length) {
      throw new Error(
        `Binance Spot OCO had no verifiable leg identities during cancellation for ${symbol}`,
      );
    }

    const openOrders = await this.getOpenOrders(symbol);
    const survivors = openOrders.filter((order: any) =>
      orderIds.includes(Number(order.orderId)),
    );
    if (survivors.length > 0) {
      throw new Error(
        `Binance Spot OCO legs are still open after cancellation for ${symbol}`,
      );
    }
  }


  private async getProtectiveOrderIds(
    symbol: string,
    side: 'BUY' | 'SELL',
  ): Promise<number[]> {
    if (!this.isFutures) return [];
    const openOrders = await this.getOpenAlgoOrders(symbol);
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    return openOrders
      .filter((order: any) => {
        const type = String(order.type ?? '').toUpperCase();
        const orderSide = String(order.side ?? '').toUpperCase();
        const closePosition = String(order.closePosition).toLowerCase() === 'true';
        return (
          orderSide === closeSide &&
          closePosition &&
          (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET')
        );
      })
      .map((order: any) => Number(order.orderId))
      .filter((id: number) => Number.isFinite(id) && id > 0);
  }

  async cancelProtectionByOperationKey(
    symbol: string,
    entrySide: 'BUY' | 'SELL',
    operationKey: string,
  ): Promise<void> {
    if (!this.isFutures) {
      throw new Error('Futures protection cancellation called for a non-Futures executor');
    }
    if (!operationKey || !operationKey.trim()) {
      throw new Error('Exact prior protection operation key is required');
    }

    const closeSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
    const terminalCanceledStatuses = new Set([
      'CANCELED', 'EXPIRED', 'REJECTED',
    ]);

    for (const kind of ['SL', 'TP'] as const) {
      const expectedClientAlgoId = this.makeProtectionClientOrderId(operationKey, kind);
      const order = await this.getAlgoOrderByClientIdStrict(symbol, expectedClientAlgoId);
      if (!order) continue;

      const algoId = Number(order.orderId);
      const expectedType = kind === 'SL' ? 'STOP_MARKET' : 'TAKE_PROFIT_MARKET';
      const status = String(order.status ?? '').trim().toUpperCase();
      if (
        !(algoId > 0) ||
        !Number.isFinite(algoId) ||
        String(order.symbol ?? '').trim().toUpperCase() !== String(symbol).trim().toUpperCase() ||
        String(order.clientOrderId ?? '') !== expectedClientAlgoId ||
        String(order.side ?? '').trim().toUpperCase() !== closeSide ||
        String(order.type ?? '').trim().toUpperCase() !== expectedType ||
        String(order.closePosition).trim().toLowerCase() !== 'true'
      ) {
        throw new Error(
          `Prior operation-owned Futures ${kind} identity/shape mismatch for ${symbol}; refusing cancellation`,
        );
      }

      if (terminalCanceledStatuses.has(status)) continue;
      if (status !== 'NEW') {
        throw new Error(
          `Prior operation-owned Futures ${kind} has status=${status || 'UNKNOWN'} for ${symbol}; trigger/execution cannot be ruled out`,
        );
      }

      try {
        const response = await this.signedDelete('/fapi/v1/algoOrder', {
          symbol,
          algoId,
        });
        if (
          response?.algoId != null &&
          Number(response.algoId) !== algoId
        ) {
          throw new Error(`Prior Futures ${kind} cancellation returned a different algoId`);
        }
        if (
          response?.clientAlgoId != null &&
          String(response.clientAlgoId) !== expectedClientAlgoId
        ) {
          throw new Error(`Prior Futures ${kind} cancellation returned a different clientAlgoId`);
        }
      } catch (cancelError: any) {
        const confirmed = await this.getAlgoOrderByClientIdStrict(
          symbol,
          expectedClientAlgoId,
        );
        const confirmedStatus = String(confirmed?.status ?? '').trim().toUpperCase();
        if (!confirmed || !terminalCanceledStatuses.has(confirmedStatus)) {
          throw new Error(
            `Prior Futures ${kind} cancellation is ambiguous for ${symbol}/${expectedClientAlgoId}: ${String(cancelError?.message ?? cancelError)}`,
          );
        }
      }

      const confirmed = await this.getAlgoOrderByClientIdStrict(
        symbol,
        expectedClientAlgoId,
      );
      const confirmedStatus = String(confirmed?.status ?? '').trim().toUpperCase();
      if (
        !confirmed ||
        String(confirmed.symbol ?? '').trim().toUpperCase() !== String(symbol).trim().toUpperCase() ||
        String(confirmed.clientOrderId ?? '') !== expectedClientAlgoId ||
        !terminalCanceledStatuses.has(confirmedStatus)
      ) {
        throw new Error(
          `Prior Futures ${kind} cancellation was not authoritatively verified for ${symbol}`,
        );
      }
    }

    const openAlgoOrders = await this.getOpenAlgoOrders(symbol);
    const priorIds = new Set([
      this.makeProtectionClientOrderId(operationKey, 'SL'),
      this.makeProtectionClientOrderId(operationKey, 'TP'),
    ]);
    if (openAlgoOrders.some((order: any) => priorIds.has(String(order.clientOrderId ?? '')))) {
      throw new Error(`Prior operation-owned Futures protection remains open for ${symbol}`);
    }
  }

  async modifyPosition(
    ticket: number,
    symbol: string,
    side: 'BUY' | 'SELL',
    newSl: number,
    newTp: number,
    protectionKey?: string,
    currentProtectionKey?: string,
    persistState?: (state: Record<string, unknown>) => Promise<boolean>,
  ): Promise<boolean> {
    if (!this.isFutures) return false;
    if (!protectionKey || !protectionKey.trim()) return false;
    if (!currentProtectionKey || !currentProtectionKey.trim()) {
      this.logger.warn(`modifyPosition blocked: exact current protection identity is unavailable for ${symbol}`);
      return false;
    }
    if (protectionKey === currentProtectionKey) {
      this.logger.warn(`modifyPosition blocked: current and replacement protection identities are identical for ${symbol}`);
      return false;
    }
    if (!persistState) {
      this.logger.warn(`modifyPosition blocked: durable recovery callback is required for ${symbol}`);
      return false;
    }

    let position: any = null;
    let quantity = 0;
    let oldSl = 0;
    let oldTp = 0;
    let snapshot: Record<string, unknown> | null = null;
    let destructiveStarted = false;
    const save = async (phase: string, extra: Record<string, unknown> = {}) => {
      const next = { ...(snapshot ?? {}), phase, updatedAt: Date.now(), ...extra };
      if (!(await persistState(next))) {
        throw new Error(`Could not durably persist Binance protection phase ${phase} for ${symbol}`);
      }
      snapshot = next;
    };
    const signalFor = (sl: number, tp: number): Signal => ({
      symbol, side, price: Number(position?.entryPrice ?? 0),
      confidence: 1, sl, tp, source: 'modify', reason: 'modify', timestamp: Date.now(),
    } as Signal);
    const pairIsActive = async (key: string, slPrice: number, tpPrice: number) => {
      const pair = await this.recoverProtectionByOperation(symbol, key);
      const ids = this.validateFuturesProtectionPair(
        signalFor(slPrice, tpPrice), quantity,
        this.formatPrice(slPrice, getSymbolSpec(symbol).pip),
        this.formatPrice(tpPrice, getSymbolSpec(symbol).pip),
        pair,
      );
      return ids ? { pair, ids } : null;
    };
    const hasOpenPair = async (key: string) => {
      const ids = new Set([
        this.makeProtectionClientOrderId(key, 'SL'),
        this.makeProtectionClientOrderId(key, 'TP'),
      ]);
      const orders = await this.getOpenAlgoOrders(symbol);
      return orders.some((order: any) => ids.has(String(order.clientOrderId ?? '')));
    };

    try {
      position = await this.getPosition(symbol);
      if (!position) throw new Error(`Binance position state unavailable while modifying ${symbol}`);
      if (
        !Number.isFinite(Number(position.positionAmt)) ||
        Number(position.positionAmt) === 0 ||
        (side === 'BUY' && Number(position.positionAmt) <= 0) ||
        (side === 'SELL' && Number(position.positionAmt) >= 0)
      ) {
        throw new Error(`Binance position side does not match the trade being modified for ${symbol}`);
      }
      quantity = Math.abs(Number(position.positionAmt));
      if (!(quantity > 0) || !Number.isFinite(quantity)) {
        throw new Error(`Binance position quantity is invalid for ${symbol}`);
      }

      const oldPair = await this.recoverProtectionByOperation(symbol, currentProtectionKey);
      oldSl = Number(oldPair?.sl?.stopPrice);
      oldTp = Number(oldPair?.tp?.stopPrice);
      if (!(oldSl > 0) || !(oldTp > 0) || !Number.isFinite(oldSl) || !Number.isFinite(oldTp)) {
        throw new Error(`Current operation-owned SL/TP prices could not be recovered for ${symbol}`);
      }
      const oldValid = this.validateFuturesProtectionPair(
        signalFor(oldSl, oldTp), quantity,
        this.formatPrice(oldSl, getSymbolSpec(symbol).pip),
        this.formatPrice(oldTp, getSymbolSpec(symbol).pip),
        oldPair,
      );
      if (!oldValid) {
        throw new Error(`Current operation-owned SL/TP pair is not a verified active pair for ${symbol}`);
      }
      const restoreKey = `PROTECTION_RESTORE:${protectionKey}:${currentProtectionKey}`;
      snapshot = {
        schemaVersion: 1,
        symbol,
        ticket,
        positionSide: side,
        quantity,
        oldProtectionKey: currentProtectionKey,
        newProtectionKey: protectionKey,
        restoreProtectionKey: restoreKey,
        oldProtection: {
          slClientAlgoId: this.makeProtectionClientOrderId(currentProtectionKey, 'SL'),
          tpClientAlgoId: this.makeProtectionClientOrderId(currentProtectionKey, 'TP'),
          slAlgoId: oldValid.slOrderId,
          tpAlgoId: oldValid.tpOrderId,
          slPrice: oldSl,
          tpPrice: oldTp,
        },
        requestedProtection: {
          slPrice: newSl,
          tpPrice: newTp,
          slClientAlgoId: this.makeProtectionClientOrderId(protectionKey, 'SL'),
          tpClientAlgoId: this.makeProtectionClientOrderId(protectionKey, 'TP'),
        },
        activeProtectionKey: currentProtectionKey,
      };
      await save('PREPARED');

      await save('OLD_CANCEL_REQUESTED');
      destructiveStarted = true;
      await this.cancelProtectionByOperationKey(symbol, side, currentProtectionKey);
      await save('OLD_CANCEL_VERIFIED');

      await save('NEW_PAIR_REQUESTED');
      await this.placeSLTP(
        signalFor(newSl, newTp),
        quantity,
        ticket,
        getSymbolSpec(symbol),
        protectionKey,
      );
      const newPair = await pairIsActive(protectionKey, newSl, newTp);
      if (!newPair) throw new Error(`Replacement SL/TP pair did not pass exact broker verification for ${symbol}`);
      await save('NEW_PAIR_VERIFIED', {
        activeProtectionKey: protectionKey,
        newSlAlgoId: newPair.ids.slOrderId,
        newTpAlgoId: newPair.ids.tpOrderId,
      });
      return true;
    } catch (e: any) {
      const failure = String(e?.message ?? e);
      this.logger.warn(`modifyPosition failed: ${failure}`);
      if (!snapshot || !persistState || !quantity) return false;

      try {
        if (!destructiveStarted) {
          await save('OLD_PAIR_RETAINED', {
            activeProtectionKey: currentProtectionKey,
            recoveryError: failure,
          });
          return false;
        }

        // Remove only replacement orders owned by this operation before deciding whether restoration is needed.
        await this.cancelProtectionByOperationKey(symbol, side, protectionKey);
        if (await hasOpenPair(protectionKey)) {
          throw new Error(`Replacement Algo orders remain open for ${symbol}`);
        }

        const oldStillActive = await pairIsActive(
          currentProtectionKey,
          Number((snapshot.oldProtection as any)?.slPrice),
          Number((snapshot.oldProtection as any)?.tpPrice),
        );
        if (oldStillActive) {
          await save('OLD_PAIR_RETAINED', {
            activeProtectionKey: currentProtectionKey,
            recoveryError: failure,
          });
          return false;
        }

        // A partial cancellation can leave one old leg active; cancel only that exact old pair before restoring both legs.
        await this.cancelProtectionByOperationKey(symbol, side, currentProtectionKey);
        if (await hasOpenPair(currentProtectionKey)) {
          throw new Error(`Prior protection could not be fully retired before restoration for ${symbol}`);
        }

        const savedOld = snapshot.oldProtection as { slPrice: number; tpPrice: number };
        await save('RESTORE_REQUESTED', { activeProtectionKey: null, recoveryError: failure });
        await this.placeSLTP(
          signalFor(Number(savedOld.slPrice), Number(savedOld.tpPrice)),
          quantity,
          ticket,
          getSymbolSpec(symbol),
          String(snapshot.restoreProtectionKey),
        );
        const restored = await pairIsActive(
          String(snapshot.restoreProtectionKey),
          Number(savedOld.slPrice),
          Number(savedOld.tpPrice),
        );
        if (!restored) throw new Error(`Restored SL/TP pair could not be verified for ${symbol}`);
        await save('RESTORE_VERIFIED', {
          activeProtectionKey: String(snapshot.restoreProtectionKey),
          restoreSlAlgoId: restored.ids.slOrderId,
          restoreTpAlgoId: restored.ids.tpOrderId,
          recoveryError: failure,
        });
        return false;
      } catch (recoveryError: any) {
        const message = String(recoveryError?.message ?? recoveryError);
        this.logger.error(`CRITICAL: Binance protection recovery blocked for ${symbol}: ${message}`);
        try {
          await save('BLOCKED_UNKNOWN', {
            activeProtectionKey: null,
            recoveryError: failure,
            lastRecoveryError: message,
          });
        } catch (persistError: any) {
          this.logger.error(`CRITICAL: could not persist blocked protection state for ${symbol}: ${String(persistError?.message ?? persistError)}`);
        }
        return false;
      }
    }
  }

  async closePartialPosition(
    ticket:number,
    symbol:string,
    volume:number,
    clientOrderId?: string,
  ):Promise<{
    ok:boolean;
    remainingVolume:number;
    realizedProfit:number;
    realizedProfitCurrency:string|null;
  }>{
    if(!this.isFutures || !(volume>0)) {
      return {
        ok:false,
        remainingVolume:0,
        realizedProfit:0,
        realizedProfitCurrency:null,
      };
    }
    try {
      const pos=await this.getPosition(symbol);
      if(!pos || pos.positionAmt===0) {
        return {
          ok:false,
          remainingVolume:0,
          realizedProfit:0,
          realizedProfitCurrency:null,
        };
      }

      const available=Math.abs(pos.positionAmt);
      const qty=Math.min(volume,available);
      if(!(qty>0)) {
        return {
          ok:false,
          remainingVolume:available,
          realizedProfit:0,
          realizedProfitCurrency:null,
        };
      }

      const closeSide=pos.positionAmt>0?'SELL':'BUY';
      const order=await this.signedPost('/fapi/v1/order',{
        symbol,
        side:closeSide,
        type:'MARKET',
        quantity:this.formatQty(qty,getSymbolSpec(symbol).volumeStep),
        reduceOnly:'true',
        ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
      });

      const orderId=Number(order?.orderId);
      if(!(orderId>0) || !Number.isFinite(orderId)) {
        throw new Error('Binance partial close returned invalid orderId');
      }

      const executedQty = Number(order?.executedQty ?? order?.origQty ?? 0);
      const status = String(order?.status ?? '').toUpperCase();
      if (status && status !== 'FILLED') {
        throw new Error(`Binance partial close was not fully filled: status=${status}`);
      }
      if (
        !(executedQty > 0) ||
        Math.abs(executedQty - qty) >
          Math.max(getSymbolSpec(symbol).volumeStep, qty * 0.0001)
      ) {
        throw new Error(
          `Binance partial close executed unexpected quantity: requested=${qty} executed=${executedQty}`,
        );
      }

      const after=await this.getPosition(symbol);
      if (!after) {
        throw new Error(
          `Binance partial close ${symbol} executed but remaining position could not be verified`,
        );
      }
      const remainingVolume=Math.max(0,Math.abs(after.positionAmt));

      const realized=await this.getFuturesOrderNetPnl(symbol,orderId);
      if(realized==null) {
        throw new Error(
          `Binance partial close ${symbol} executed but authoritative fills/PnL are unavailable`,
        );
      }

      const ids=this.orderMap.get(ticket);
      if(ids) ids.quantity=remainingVolume;

      return {
        ok:true,
        remainingVolume,
        realizedProfit:realized.profit,
        realizedProfitCurrency:realized.currency,
      };
    }catch(e:any){
      this.logger.error(`closePartialPosition failed: ${e?.message??e}`);
      return {
        ok:false,
        remainingVolume:0,
        realizedProfit:0,
        realizedProfitCurrency:null,
      };
    }
  }


  // ─── Close position ───────────────────────────────────────────────────

  async closePosition(
    ticket: number,
    symbol: string,
    volume?: number,
    side?: 'BUY' | 'SELL',
    clientOrderId?: string,
    protectionOperationKey?: string,
    entryPrice?: number,
  ): Promise<{
    ok: boolean;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  }> {
    let realizedProfit: number | null = null;
    let realizedProfitCurrency: string | null = null;

    try {
      const ids = this.orderMap.get(ticket);
      const trackedIds = [
        ids?.slOrderId,
        ids?.tpOrderId,
      ].filter((id): id is number => Number.isFinite(id));

      if (
        !this.isFutures &&
        protectionOperationKey
      ) {
        await this.cancelSpotProtectionByOperation(
          symbol,
          protectionOperationKey,
        );
      } else if (
        !this.isFutures &&
        trackedIds.length === 0
      ) {
        throw new Error(
          `Binance Spot close lacks an authoritative OCO identity after restart for ${symbol}`,
        );
      }
      let protectionSide: 'BUY' | 'SELL' | undefined = side;
      if (!protectionSide && ids?.closeSide) {
        protectionSide = ids.closeSide === 'SELL' ? 'BUY' : 'SELL';
      }

      if (this.isFutures && protectionOperationKey) {
        if (!protectionSide) {
          throw new Error(
            `Binance Futures close lacks an authoritative position side for operation-owned protection cleanup: ${symbol}`,
          );
        }
        await this.cancelProtectionForEmergencyClose({
          symbol,
          side: protectionSide,
          price: Number(entryPrice ?? 0),
          sl: 0,
          tp: 0,
          confidence: 1,
          timestamp: Date.now(),
          source: 'close-protection-cleanup',
        } as Signal, protectionOperationKey);
      }

      const brokerProtectionIds =
        this.isFutures && protectionSide && !protectionOperationKey
          ? await this.getProtectiveOrderIds(symbol, protectionSide)
          : [];
      const oldOrderIds = this.isFutures
        ? protectionOperationKey
          ? []
          : [...new Set([...trackedIds, ...brokerProtectionIds])]
        : protectionOperationKey
          ? []
          : [...new Set(trackedIds)];

      for (const orderId of oldOrderIds) {
        await this.signedDelete(
          this.isFutures ? '/fapi/v1/algoOrder' : '/api/v3/order',
          this.isFutures ? { symbol, algoId: orderId } : { symbol, orderId },
        );
      }

      if (oldOrderIds.length) {
        const openOrders = this.isFutures
          ? await this.getOpenAlgoOrders(symbol)
          : await this.getOpenOrders(symbol);
        const staleProtectiveOrders = openOrders.filter((order: any) =>
          oldOrderIds.includes(Number(order.orderId)),
        );
        if (staleProtectiveOrders.length > 0) {
          throw new Error(
            `Binance protective order cancellation could not be verified for ${symbol}`,
          );
        }
      }

      this.orderMap.delete(ticket);

      if (this.isFutures) {
        const pos = await this.getPosition(symbol);
        if (!pos) {
          throw new Error(
            `Binance position state unavailable while closing ${symbol}`,
          );
        }
        if (pos.positionAmt === 0) {
          throw new Error(
            `Binance position ${symbol} is already flat; ownership of a prior close cannot be inferred safely`,
          );
        }

        const closeQty = volume ?? Math.abs(pos.positionAmt);
        const closeSide = pos.positionAmt > 0 ? 'SELL' : 'BUY';

        const closeOrder = await this.signedPost('/fapi/v1/order', {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: this.formatQty(
            Math.abs(closeQty),
            getSymbolSpec(symbol).volumeStep,
          ),
          reduceOnly: 'true',
          ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
        });

        const closeOrderId = Number(closeOrder?.orderId);
        if (!(closeOrderId > 0) || !Number.isFinite(closeOrderId)) {
          throw new Error('Binance full close returned invalid orderId');
        }

        const executedQty = Number(
          closeOrder?.executedQty ?? closeOrder?.origQty ?? 0,
        );
        const closeStatus = String(closeOrder?.status ?? '').toUpperCase();
        const quantityTolerance = Math.max(
          getSymbolSpec(symbol).volumeStep,
          Math.abs(closeQty) * 0.0001,
        );
        if (closeStatus && closeStatus !== 'FILLED') {
          throw new Error(
            `Binance full close was not fully filled: status=${closeStatus}`,
          );
        }
        if (
          !(executedQty > 0) ||
          Math.abs(executedQty - Math.abs(closeQty)) > quantityTolerance
        ) {
          throw new Error(
            `Binance full close executed unexpected quantity: requested=${Math.abs(closeQty)} executed=${executedQty}`,
          );
        }

        const after = await this.getPosition(symbol);
        if (!after) {
          throw new Error(
            `Binance full close ${symbol} executed but zero position could not be verified`,
          );
        }
        const remaining = Math.abs(after.positionAmt);
        if (remaining > quantityTolerance) {
          throw new Error(
            `Binance full close left position open: ${symbol} remaining=${remaining}`,
          );
        }

        const realized = await this.getFuturesOrderNetPnl(
          symbol,
          closeOrderId,
        );
        if (realized == null) {
          throw new Error(
            `Binance full close ${symbol} executed but authoritative fills/PnL are unavailable`,
          );
        }

        realizedProfit = realized.profit;
        realizedProfitCurrency = realized.currency;
      } else {
        const closeSide = ids?.closeSide ?? (
          side === 'BUY'
            ? 'SELL'
            : side === 'SELL'
              ? 'BUY'
              : undefined
        );
        const closeQty = volume ?? ids?.quantity;

        if (!closeSide || !(closeQty > 0)) {
          return {
            ok:false,
            realizedProfit:null,
            realizedProfitCurrency:null,
          };
        }

        const spec = getSymbolSpec(symbol);
        const before = await this.getPosition(symbol);
        if (!before) {
          throw new Error(
            `Binance Spot position state unavailable before closing ${symbol}`,
          );
        }
        const available = Number(before.positionAmt);
        const quantityTolerance = Math.max(
          spec.volumeStep,
          Math.abs(closeQty) * 0.0001,
        );
        if (
          !(available > 0) ||
          !Number.isFinite(available) ||
          closeQty > available + quantityTolerance
        ) {
          throw new Error(
            `Binance Spot close quantity exceeds verified inventory for ${symbol}: requested=${closeQty} available=${available}`,
          );
        }

        const closeOrder = await this.signedPost('/api/v3/order', {
          symbol,
          side: closeSide,
          type: 'MARKET',
          quantity: this.formatQty(
            closeQty,
            spec.volumeStep,
          ),
          newOrderRespType: 'FULL',
        });

        const status = String(closeOrder?.status ?? '').toUpperCase();
        const executedQty = Number(
          closeOrder?.executedQty ??
          closeOrder?.origQty ??
          0,
        );
        if (status && status !== 'FILLED') {
          throw new Error(
            `Binance Spot market close was not fully filled: status=${status}`,
          );
        }
        if (
          !(executedQty > 0) ||
          Math.abs(executedQty - closeQty) > quantityTolerance
        ) {
          throw new Error(
            `Binance Spot market close executed unexpected quantity: requested=${closeQty} executed=${executedQty}`,
          );
        }

        const orderId = Number(closeOrder?.orderId);
        if (!(orderId > 0) || !Number.isFinite(orderId)) {
          throw new Error(
            `Binance Spot market close returned invalid orderId for ${symbol}`,
          );
        }

        if (
          !Number.isFinite(Number(entryPrice)) ||
          !(Number(entryPrice) > 0) ||
          !side
        ) {
          throw new Error(
            `Binance Spot close lacks the local entry price/side required for authoritative PnL for ${symbol}`,
          );
        }

        const realized = await this.getSpotOrderNetPnl(
          symbol,
          orderId,
          Number(entryPrice),
          side,
          executedQty,
        );
        if (!realized) {
          throw new Error(
            `Binance Spot close fills/PnL could not be verified for ${symbol}`,
          );
        }
        realizedProfit = realized.profit;
        realizedProfitCurrency = realized.currency;

        const after = await this.getPosition(symbol);
        if (!after) {
          throw new Error(
            `Binance Spot post-close position state unavailable for ${symbol}`,
          );
        }
        const remaining = Number(after.positionAmt);
        const expectedRemaining = available - executedQty;
        if (
          !Number.isFinite(remaining) ||
          !Number.isFinite(expectedRemaining) ||
          expectedRemaining < -quantityTolerance ||
          Math.abs(remaining - expectedRemaining) > quantityTolerance
        ) {
          throw new Error(
            `Binance Spot market close produced an unexpected inventory transition for ${symbol}: before=${available} executed=${executedQty} after=${remaining}`,
          );
        }
      }

      return {
        ok: true,
        realizedProfit,
        realizedProfitCurrency,
      };
    } catch(e:any) {
      this.logger.error(`closePosition failed: ${e?.message??e}`);
      return {
        ok:false,
        realizedProfit:null,
        realizedProfitCurrency:null,
      };
    }
  }


  // ─── Get position ────────────────────────────────────────────────────

  async getPosition(symbol: string): Promise<{ positionAmt: number; entryPrice: number; unrealizedProfit: number } | null> {
    if (this.isFutures) {
      const res = await this.signedGet('/fapi/v2/positionRisk', { symbol });
      const pos = Array.isArray(res) ? res.find((p: any) => p.symbol === symbol) : res;
      if (!pos) return null;
      const positionAmt = Number(pos.positionAmt);
      const entryPrice = Number(pos.entryPrice);
      const unrealizedProfit = Number(pos.unRealizedProfit);
      if (![positionAmt, entryPrice, unrealizedProfit].every(Number.isFinite)) {
        throw new Error(`Binance returned invalid futures position metadata for ${symbol}`);
      }
      return { positionAmt, entryPrice, unrealizedProfit };
    }

    // Spot has no positionRisk endpoint. Reconciliation treats the base-asset
    // free+locked balance as the authoritative open position amount.
    const quote = ['USDT', 'USDC', 'BUSD'].find(q => symbol.endsWith(q));
    if (!quote) throw new Error(`Unsupported Binance Spot quote asset for ${symbol}`);
    const baseAsset = symbol.slice(0, -quote.length);
    const account = await this.signedGet('/api/v3/account', {});
    const balance = (account.balances as any[])?.find(
      (b: any) => String(b.asset).toUpperCase() === baseAsset,
    );
    if (!balance) return { positionAmt: 0, entryPrice: 0, unrealizedProfit: 0 };

    const free = Number(balance.free ?? 0);
    const locked = Number(balance.locked ?? 0);
    if (![free, locked].every(Number.isFinite) || free < 0 || locked < 0) {
      throw new Error(`Binance returned invalid spot balance for ${baseAsset}`);
    }
    return {
      positionAmt: free + locked,
      entryPrice: 0,
      unrealizedProfit: 0,
    };
  }


  // ─── Account equity ──────────────────────────────────────────────────

  async accountEquity(): Promise<number> {
    if (this.isFutures) {
      const r = await this.signedGet('/fapi/v2/account', {});
      // totalMarginBalance includes current unrealized PnL and is the proper
      // current-equity basis for drawdown and exposure controls.
      const equity = Number(r.totalMarginBalance);
      if (!(equity > 0) || !Number.isFinite(equity)) {
        throw new Error('Binance futures margin equity unavailable or invalid');
      }
      return equity;
    }

    const r = await this.signedGet('/api/v3/account', {});
    if (!Array.isArray(r?.balances)) {
      throw new Error('Binance spot account balances unavailable or invalid');
    }

    const stable = new Set(['USDT', 'USDC', 'BUSD']);
    const balances = r.balances
      .map((b: any) => ({
        asset: String(b.asset ?? '').toUpperCase(),
        quantity: Number(b.free ?? 0) + Number(b.locked ?? 0),
      }))
      .filter((b: any) =>
        b.asset &&
        Number.isFinite(b.quantity) &&
        b.quantity > 0,
      );

    let equity = 0;
    const nonStable = balances.filter((b: any) => !stable.has(b.asset));

    for (const balance of balances) {
      if (stable.has(balance.asset)) {
        // USDT/USDC/BUSD are treated as USD-equivalent settlement assets in
        // this executor, consistent with the rest of the spot risk model.
        equity += balance.quantity;
      }
    }

    if (nonStable.length) {
      const priced = await Promise.all(
        nonStable.map(async (balance: any) => {
          const symbol = `${balance.asset}USDT`;
          try {
            const quote = await this.http.get('/api/v3/ticker/price', {
              params: { symbol },
              timeout: 5_000,
            });
            const price = Number(quote.data?.price);
            if (!(price > 0) || !Number.isFinite(price)) {
              throw new Error('invalid ticker price');
            }
            return balance.quantity * price;
          } catch {
            return null;
          }
        }),
      );

      if (priced.some(value => value == null)) {
        throw new Error('Binance spot equity incomplete: at least one non-stable asset cannot be marked to USDT');
      }

      equity += priced.reduce((sum, value) => sum + Number(value), 0);
    }

    if (!(equity > 0) || !Number.isFinite(equity)) {
      throw new Error('Binance spot account equity unavailable or invalid');
    }
    return equity;
  }


  async getAllPositions(): Promise<Array<{ symbol: string; positionAmt: number; entryPrice: number; unrealizedProfit: number }>> {
    if (!this.isFutures) return [];
    const res = await this.signedGet('/fapi/v2/positionRisk', {});
    if (!Array.isArray(res)) throw new Error('Binance positionRisk response is not an array');
    return res.map((p: any) => ({
      symbol: String(p.symbol),
      positionAmt: Number(p.positionAmt),
      entryPrice: Number(p.entryPrice),
      unrealizedProfit: Number(p.unRealizedProfit),
    })).filter(p =>
      Number.isFinite(p.positionAmt) &&
      Number.isFinite(p.entryPrice) &&
      Number.isFinite(p.unrealizedProfit) &&
      p.positionAmt !== 0
    );
  }

  async getAllSpotBalancesForConfiguredSymbols(): Promise<any[]> {
    if (this.isFutures) return [];
    const account = await this.signedGet('/api/v3/account', {});
    if (!Array.isArray(account?.balances)) {
      throw new Error('Binance Spot account balances response is invalid');
    }
    return account.balances
      .map((b: any) => ({
        asset: String(b.asset ?? '').toUpperCase(),
        free: Number(b.free ?? 0),
        locked: Number(b.locked ?? 0),
      }))
      .filter((b: any) => b.asset && Number.isFinite(b.free) && Number.isFinite(b.locked) && (b.free > 0 || b.locked > 0));
  }

  // ─── Open orders ────────────────────────────────────────────────────

  async getOpenOrders(symbol?: string): Promise<any[]> {
    const params = symbol ? { symbol } : {};
    const result = await this.signedGet(
      this.isFutures ? '/fapi/v1/openOrders' : '/api/v3/openOrders',
      params
    );
    if (!Array.isArray(result)) throw new Error(`Binance openOrders response is not an array${symbol ? ` for ${symbol}` : ''}`);
    return result;
  }

  // ─── Signed HTTP helpers ─────────────────────────────────────────────

  private sign(params: Record<string, unknown>): string {
    const qs  = new URLSearchParams({ ...params, timestamp: Date.now() } as any).toString();
    const sig = crypto
      .createHmac('sha256', this.config.binance.secret)
      .update(qs)
      .digest('hex');
    return `${qs}&signature=${sig}`;
  }

  private async signedPost(path: string, params: Record<string, unknown>): Promise<any> {
    const body = this.sign(params);
    const r    = await this.http.post(`${path}?${body}`);
    return r.data;
  }

  private async signedGet(path: string, params: Record<string, unknown>): Promise<any> {
    const qs = this.sign(params);
    const r  = await this.http.get(`${path}?${qs}`);
    return r.data;
  }

  private async signedDelete(path: string, params: Record<string, unknown>): Promise<any> {
    const qs = this.sign(params);
    const r  = await this.http.delete(`${path}?${qs}`);
    return r.data;
  }

  private formatQty(qty: number, step: number): string {
    const d = Math.max(0, Math.ceil(-Math.log10(step)));
    return qty.toFixed(d);
  }

  private formatPrice(price: number, pip: number): string {
    const d = Math.max(0, Math.ceil(-Math.log10(pip)));
    return price.toFixed(d);
  }
}
