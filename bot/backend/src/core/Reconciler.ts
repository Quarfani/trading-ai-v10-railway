    } catch (e) {
      throw new Error(`MT5 history lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ─── Binance ────────────────────────────────────────────────────────

  private async reconcileBinance(t: Trade): Promise<void> {
    if (!t.ticket) return;
      const pos  = await this.exec.getBinancePosition(t.symbol);

      if (!pos || Math.abs(pos.positionAmt) < 0.0001) {
        // Binance has disappeared from the live position set, but this reconciler
        // does not yet fetch authoritative account-trade fills/PnL. Never infer a
        // profitable/losing close from market candles; stop and require reconciliation.
        throw new Error(`Binance position ${t.symbol} is absent but authoritative fill/PnL history is unavailable`);

      } else if (Math.abs(pos.positionAmt) < t.volume - 0.001) {
        const unresolvedPartial = t.id != null
          ? this.db.getLatestUnresolvedExecutionForTrade(t.id, ['PARTIAL_CLOSE'])
          : null;

        // Never silently absorb an externally changed Binance position. A
        // partial reduction is reconciled only when it maps to a durable bot
        // operation that can be identified and its fills/PnL recovered.
        if (!unresolvedPartial) {
          throw new Error(
            `Binance position size decreased for ${t.symbol} without an attributable PARTIAL_CLOSE ledger entry; manual reconciliation is required`,
          );
        }

        const recovered = await this.exec.reconcileBinancePartialClose(
          String(unresolvedPartial.operationKey),
          t.symbol,
        );

        const remaining = Number(recovered.remainingVolume);
        const positionTolerance = Math.max(
          1e-12,
          Number(t.volume) * 0.02,
        );
        if (
          !Number.isFinite(remaining) ||
          remaining < 0 ||
          Math.abs(remaining - Math.abs(pos.positionAmt)) > positionTolerance
        ) {
          throw new Error(
            `Binance partial recovery volume mismatch for ${t.symbol}: history=${remaining} live=${Math.abs(pos.positionAmt)}`,
          );
        }

        const priorRealized = Number(t.realizedProfit ?? 0);
        const cumulativeRealized = priorRealized + Number(recovered.realizedProfit);
        if (!Number.isFinite(cumulativeRealized)) {
          throw new Error(
            `Binance partial recovery PnL is invalid for ${t.symbol}`,
          );
        }

        const resolved = this.db.resolveReconciledPartialClose(
          t.id!,
          String(unresolvedPartial.executionId),
          remaining,
          cumulativeRealized,
          {
            broker: 'binance',
            symbol: t.symbol,
            orderId: recovered.orderId,
            executedQty: recovered.executedQty,
            remainingVolume: remaining,
            realizedProfit: recovered.realizedProfit,
            cumulativeRealizedProfit: cumulativeRealized,
            runtimeReconciliation: true,
          },
          recovered.orderId,
        );
        if (!resolved) {
          throw new Error(
            `Could not atomically reconcile Binance partial operation=${unresolvedPartial.executionId}`,
          );
        }

        t.volume = remaining;
        t.realizedProfit = cumulativeRealized;
        this.logger.info(
          `[${t.symbol}] Binance partial recovered order=${recovered.orderId} remaining=${remaining} cumulativePnL=${cumulativeRealized.toFixed(8)}`,
        );
      }
  }

  // ─── Common close + record ─────────────────────────────────────────

  private async closeAndRecord(
    t:          Trade,
    exitPrice:  number,
    exitReason: string,
    profit?:    number,
  ): Promise<void> {
    let rawProfit = profit;
    let persistedByExecutionGateway = false;

    if (rawProfit === undefined && this.config.mode === 'paper') {
      const settled = await this.exec.closeAtMarket(
        t,
        exitPrice,
        exitReason as 'TP' | 'SL' | 'TIMEOUT' | 'MANUAL',
      );
      if (!settled.ok || !Number.isFinite(Number(settled.profit))) {
        throw new Error(
          'Paper settlement could not produce authoritative PnL for ticket=' +
          t.ticket,
        );
      }
      rawProfit = Number(settled.profit);
      persistedByExecutionGateway = true;
    }

    // Never synthesize broker/account PnL from price differences. MT5/Binance
    // callers must provide authoritative realized PnL from broker history.
    if (rawProfit === undefined || !Number.isFinite(Number(rawProfit))) {
      throw new Error('Authoritative PnL unavailable for ticket=' + t.ticket);
    }

    const finalProfit = Number(rawProfit);