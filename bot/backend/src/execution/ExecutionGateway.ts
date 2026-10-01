        remaining = +brokerRemaining.toFixed(8);
        realizedProfit = +brokerProfit.toFixed(8);
        const mt5DealTicket = Number(r.data?.close_deal_ticket);
        if (Number.isFinite(mt5DealTicket) && mt5DealTicket > 0) {
          brokerOrderId = mt5DealTicket;
        }
      } else if (this.config.mode === 'binance') {
        if (!t.ticket) throw new Error('Binance partial close requires broker ticket');
        const result = await this.binance.closePartialPosition(
          t.ticket,
          t.symbol,
          volume,
          makeBinanceClientOrderId(key),
        );
        if (!result.ok) throw new Error('Binance partial close rejected');
        brokerOrderId = result.orderId;
        remaining = result.remainingVolume;
        realizedProfit = await this.convertBrokerProfitToAccount(
          result.realizedProfit,
          result.realizedProfitCurrency,
        );
      } else {
        if (!t.ticket) throw new Error('Paper trade has no ticket');
        const result = this.paper.partialClose(t.ticket, volume, exitPrice, reason);
        if (!result.ok) throw new Error('Paper partial close rejected');
        remaining = result.remainingVolume;
        realizedProfit = result.profit;
      }

      if (this.config.mode === 'paper') {
        throw new Error('Paper partial close reached an invalid live-settlement path');
      }

      const returnedProfit = this.settleLivePartialClose(
        t,
        op.executionId,
        remaining,
        realizedProfit,
        { remainingVolume: remaining, profit: realizedProfit },
        brokerOrderId,
      );
      return { ok: true, profit: returnedProfit, remainingVolume: remaining };
    } catch (e: any) {
      this.db.updateExecutionLedger(op.executionId, { status: this.config.mode === 'paper' ? 'FAILED' : 'UNKNOWN', error: e?.message ?? String(e) });
      this.logger.error(`closePartial: ${e?.message ?? e}`);
      return { ok: false, profit: 0, remainingVolume: t.volume };
    }
  }

  settlePaperTrade(t: Trade, exitPrice: number, reason: 'TP'|'SL'|'TIMEOUT'|'MANUAL', quoteToAccount=1) {