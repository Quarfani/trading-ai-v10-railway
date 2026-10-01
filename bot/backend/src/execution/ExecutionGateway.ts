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