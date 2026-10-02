    ticket: number,
    symbol: string,
    volume?: number,
    side?: 'BUY' | 'SELL',
    clientOrderId?: string,
  ): Promise<{
    ok: boolean;
    realizedProfit: number | null;
    realizedProfitCurrency: string | null;
  }> {
    let realizedProfit: number | null = null;