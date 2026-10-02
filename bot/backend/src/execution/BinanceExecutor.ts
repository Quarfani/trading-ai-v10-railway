      belowTimeInForce:  'GTC',
    });

    const reports = Array.isArray(oco.orderReports) ? oco.orderReports : [];
    if (reports.length < 2) throw new Error('Binance Spot OCO accepted without two order reports');
    this.logger.info(
      `[Binance Spot] OCO placed: ${signal.symbol} TP=${tpPrice} SL=${slPrice}`
    );
    const tpReport = reports.find((r: any) => String(r.type).includes('LIMIT') || r.clientOrderId === `${baseId}a`);
    const slReport = reports.find((r: any) => String(r.type).includes('STOP') || r.clientOrderId === `${baseId}b`);
    const slOrderId = Number(slReport?.orderId);
    const tpOrderId = Number(tpReport?.orderId);
    if (!(slOrderId > 0) || !(tpOrderId > 0)) {
      const createdIds = [slOrderId, tpOrderId].filter(Number.isFinite);
      await Promise.all(
        createdIds.map(orderId =>
          this.signedDelete('/api/v3/order', { symbol: signal.symbol, orderId }).catch(() => {}),
        ),
      );
      throw new Error('Binance Spot OCO response missing valid child order ids');
    }

    try {
      const openOrders = await this.getOpenOrders(signal.symbol);
      const openIds = new Set(openOrders.map((order: any) => Number(order.orderId)));
      if (!openIds.has(slOrderId) || !openIds.has(tpOrderId)) {
        throw new Error('Binance Spot OCO protection could not be verified');
      }
    } catch (verificationError) {
      await Promise.all(
        [slOrderId, tpOrderId].map(orderId =>
          this.signedDelete('/api/v3/order', { symbol: signal.symbol, orderId }).catch(() => {}),
        ),
      );
      throw verificationError;
    }

    this.orderMap.set(ticket, {
      slOrderId,
      tpOrderId,
      closeSide, quantity,
    });
  }

  // ─── Modify SL/TP ─────────────────────────────────────────────────────

  async modifyPosition(
    ticket:number,
    symbol:string,
    side:'BUY'|'SELL',
    newSl:number,
    newTp:number,
    operationKey?: string,
  ):Promise<boolean>{
    if(!this.isFutures)return false;
    try{
      const previous=this.orderMap.get(ticket);
      const oldIds=[
        previous?.slOrderId,
        previous?.tpOrderId,
        ...(previous?.staleOrderIds ?? []),
      ].filter(
        (id): id is number => Number.isFinite(id),
      );
      const quantity=previous?.quantity ?? Math.abs(
        (await this.getPosition(symbol))?.positionAmt ?? 0,
      );
      if(!(quantity>0)) return false;

      // Replace first: an accepted new SL/TP keeps the position protected.
      const sig={
        symbol, side, price:0, confidence:1, sl:newSl, tp:newTp,
        source:'modify', reason:'modify', timestamp:Date.now(),
      } as Signal;
      await this.placeSLTP(sig, quantity, ticket, getSymbolSpec(symbol), operationKey);

      const replacement=this.orderMap.get(ticket);
      const replacementIds=[replacement?.slOrderId,replacement?.tpOrderId].filter(
        (id): id is number => Number.isFinite(id),
      );
      const stale:number[]=[];
      for(const orderId of oldIds) {
        if (replacementIds.includes(orderId)) continue;