          JSON.stringify({ ...result, recoveredTradeId: duplicate.id }),
          Date.now(),
          executionId,
        ).changes;
        if (ledgerChanged !== 1) throw new Error(`Could not resolve recovered duplicate open ledger ${executionId}`);
        return duplicate.id;
      }

      const tradeId = this.insertTrade({
        ...trade,
        account: trade.account ?? 'default',
        timeframe: trade.timeframe ?? undefined,
      });

      const ledgerChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        String(brokerOrderId),
        JSON.stringify({ ...result, recoveredTradeId: tradeId }),
        Date.now(),
        executionId,
      ).changes;
      if (ledgerChanged !== 1) {
        throw new Error(`Could not resolve recovered open ledger ${executionId}`);
      }

      return tradeId;
    });
