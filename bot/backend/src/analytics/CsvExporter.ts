import { Trade } from '../types/trading.types';
import { DatabaseManager } from '../database/DatabaseManager';

export function exportTradesCSV(db: DatabaseManager): string {
  const rows = db.getRecentTrades(10000) as Trade[];
  const header = 'id,ticket,symbol,side,volume,entry,sl,tp,status,openedAt,closedAt,profit,source';
  const lines = rows.map(t => [
    t.id, t.ticket ?? '', t.symbol, t.side, t.volume, t.entry, t.sl, t.tp,
    t.status, new Date(t.openedAt).toISOString(),
    t.closedAt ? new Date(t.closedAt).toISOString() : '',
    t.profit ?? '', t.source,
  ].join(','));
  return [header, ...lines].join('\n');
}

export function getEquityCurve(db: DatabaseManager, startBalance = 1000) {
  const rows = db.raw().prepare(
    `SELECT closedAt, profit FROM trades WHERE status='closed' ORDER BY closedAt ASC`
  ).all() as Array<{ closedAt: number; profit: number }>;
  let eq = startBalance;
  return rows.map(r => { eq += r.profit; return { t: r.closedAt, equity: Number(eq.toFixed(2)) }; });
}
