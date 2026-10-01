      now, now,
    );
    return result.changes === 1;
  }

  getExecutionByOperationKey(operationKey: string): any | null {
    return this.db.prepare(`SELECT * FROM execution_ledger WHERE operationKey=?`).get(operationKey) ?? null;
  }

  getLatestUnresolvedExecutionForTrade(
    tradeId: number,
    actions?: string[],
  ): any | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM execution_ledger
      WHERE status IN ('PENDING','UNKNOWN')
      ORDER BY updatedAt DESC, createdAt DESC
    `).all() as any[];

    for (const row of rows) {
      if (!row.requestJson) continue;
      let request: any;
      try {
        request = JSON.parse(row.requestJson);
      } catch {
        continue;
      }
      if (Number(request?.tradeId) !== Number(tradeId)) continue;
      if (actions?.length && !actions.includes(String(row.action))) continue;
      return row;
    }
    return null;
  }

  hasUnresolvedExecutionForTrade(tradeId: number, actions?: string[]): boolean {
    return this.findExecutionForTradeStatus(tradeId, ['PENDING', 'UNKNOWN'], actions) != null;
  }

  hasResolvedExecutionForTrade(tradeId: number, actions?: string[]): boolean {
    return this.findExecutionForTradeStatus(tradeId, ['EXECUTED'], actions) != null;
  }

  private findExecutionForTradeStatus(
    tradeId: number,
    statuses: string[],
    actions?: string[],
  ): any | null {
    const rows = this.db.prepare(`
      SELECT *
      FROM execution_ledger
      WHERE status IN (${statuses.map(() => '?').join(',')})
      ORDER BY updatedAt DESC, createdAt DESC
    `).all(...statuses) as any[];

    for (const row of rows) {
      if (!row.requestJson) continue;
      let request: any;
      try {
        request = JSON.parse(row.requestJson);
      } catch {
        continue;
      }
      if (Number(request?.tradeId) !== Number(tradeId)) continue;
      if (actions?.length && !actions.includes(String(row.action))) continue;
      return row;
    }
    return null;
  }

  resolveReconciledPartialClose(
    tradeId: number,
    executionId: string,
    volume: number,
    realizedProfit: number,
    result: unknown,
    brokerOrderId?: string | number,
  ): boolean {
    const tx = this.db.transaction(() => {
      const trade = this.db.prepare(
        `SELECT status FROM trades WHERE id=? LIMIT 1`,
      ).get(tradeId) as { status: string } | undefined;
      if (!trade || trade.status !== 'open') return false;

      const ledger = this.db.prepare(
        `SELECT status FROM execution_ledger WHERE executionId=? LIMIT 1`,
      ).get(executionId) as { status: string } | undefined;
      if (!ledger || !['PENDING', 'UNKNOWN'].includes(ledger.status)) return false;

      const tradeChanged = this.db.prepare(
        `UPDATE trades
         SET volume=?, realizedProfit=?
         WHERE id=? AND status='open'`,
      ).run(volume, realizedProfit, tradeId).changes;
      if (tradeChanged !== 1) {
        throw new Error(`Could not persist reconciled partial trade id=${tradeId}`);
      }

      const ledgerChanged = this.db.prepare(`
        UPDATE execution_ledger
        SET status='EXECUTED', brokerOrderId=?, resultJson=?, error=NULL, updatedAt=?
        WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
      `).run(
        brokerOrderId != null ? String(brokerOrderId) : null,
        JSON.stringify(result),
        Date.now(),
        executionId,
      ).changes;
      if (ledgerChanged !== 1) {
        throw new Error(`Could not resolve reconciled partial ledger ${executionId}`);
      }
      return true;
    });

    return tx();
  }

  resolveExecutionLedger(
    executionId: string,
    result?: unknown,
    brokerOrderId?: string | number,
  ): boolean {
    const fields = [
      'status=\'EXECUTED\'',
      'updatedAt=?',
    ];
    const values: unknown[] = [Date.now()];
    if (result !== undefined) {
      fields.push('resultJson=?');
      values.push(JSON.stringify(result));
    }
    if (brokerOrderId !== undefined) {
      fields.push('brokerOrderId=?');
      values.push(String(brokerOrderId));
    }
    fields.push('error=NULL');
    values.push(executionId);

    const changed = this.db.prepare(`
      UPDATE execution_ledger
      SET ${fields.join(', ')}
      WHERE executionId=? AND status IN ('PENDING','UNKNOWN')
    `).run(...values).changes;
    return changed === 1;
  }

  updateExecutionLedger(executionId: string, patch: {
    status?: string; brokerOrderId?: string | number; retryCount?: number;
    result?: unknown; error?: string | null;
  }) {
    const fields: string[] = ['updatedAt=?'];
    const values: unknown[] = [Date.now()];
    if (patch.status !== undefined) { fields.push('status=?'); values.push(patch.status); }
    if (patch.brokerOrderId !== undefined) { fields.push('brokerOrderId=?'); values.push(String(patch.brokerOrderId)); }
    if (patch.retryCount !== undefined) { fields.push('retryCount=?'); values.push(patch.retryCount); }
    if (patch.result !== undefined) { fields.push('resultJson=?'); values.push(JSON.stringify(patch.result)); }
    if (patch.error !== undefined) { fields.push('error=?'); values.push(patch.error); }
    values.push(executionId);
    this.db.prepare(`UPDATE execution_ledger SET ${fields.join(', ')} WHERE executionId=?`).run(...values);
  }

  saveExecutionEvent(entry: {
    executionId: string; brokerOrderId?: string | number; operationKey: string;
    symbol: string; side?: string; action: string; quantity?: number; price?: number;
    status: string; latencyMs?: number; retryCount?: number; error?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO executions