import { EquityCurveChart } from './EquityCurveChart';

interface Props {
  symbol: string;
  onSymbolChange: (s: string) => void;
  onRun: () => void;
  loading: boolean;
  result: any;
}

export function BacktestPanel({ symbol, onSymbolChange, onRun, loading, result: r }: Props) {
  const SYMBOLS = ['EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD','XAUUSD','BTCUSDT','ETHUSDT'];
  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <h2 className="text-sm font-medium text-slate-300 mb-4">🔬 Backtester</h2>
        <div className="flex gap-3 items-center flex-wrap">
          <select value={symbol} onChange={e => onSymbolChange(e.target.value)}
                  className="px-3 py-2 text-sm bg-slate-800 border border-slate-700 rounded">
            {SYMBOLS.map(s => <option key={s}>{s}</option>)}
          </select>
          <button onClick={onRun} disabled={loading}
                  className="px-5 py-2 text-sm bg-blue-700 hover:bg-blue-600 disabled:opacity-50 rounded font-medium transition">
            {loading ? '⏳ Running...' : '▶ Run Backtest'}
          </button>
          {r && <span className="text-xs text-slate-400">{r.totalTrades} trades simulated</span>}
        </div>
      </div>

      {r && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label:'Total Return', value:`${r.totalReturn?.toFixed(2)}%`, pos: r.totalReturn >= 0 },
              { label:'Win Rate',     value:`${(r.winRate*100).toFixed(1)}%`, pos: r.winRate >= 0.5 },
              { label:'Profit Factor',value: r.profitFactor?.toFixed(2), pos: r.profitFactor >= 1 },
              { label:'Expectancy',   value:`$${r.expectancy?.toFixed(2)}`, pos: r.expectancy >= 0 },
              { label:'Sharpe Ratio', value: r.sharpeRatio?.toFixed(2), pos: r.sharpeRatio >= 1 },
              { label:'Sortino',      value: r.sortinoRatio?.toFixed(2), pos: r.sortinoRatio >= 1 },
              { label:'Calmar',       value: r.calmarRatio?.toFixed(2), pos: r.calmarRatio >= 0.5 },
              { label:'Max Drawdown', value:`${r.maxDrawdownPct?.toFixed(2)}%`, pos: r.maxDrawdownPct < 10 },
              { label:'Avg Win',      value:`$${r.avgWin?.toFixed(2)}`, pos: true },
              { label:'Avg Loss',     value:`$${r.avgLoss?.toFixed(2)}`, pos: false },
              { label:'R:R Ratio',    value: r.riskReward?.toFixed(2), pos: r.riskReward >= 1.5 },
              { label:'Max Streak W', value: String(r.maxConsecWins), pos: true },
              { label:'Max Streak L', value: String(r.maxConsecLosses), pos: r.maxConsecLosses < 5 },
              { label:'Commission',   value:`$${r.totalCommission?.toFixed(2)}`, pos: false },
              { label:'Trades',       value:`${r.wins}W / ${r.losses}L`, pos: null },
              { label:'End Balance',  value:`$${r.endBalance?.toFixed(2)}`, pos: r.endBalance >= r.startBalance },
            ].map(c => (
              <div key={c.label} className="bg-slate-900 border border-slate-800 rounded-xl p-3">
                <div className="text-xs text-slate-400">{c.label}</div>
                <div className={`text-base font-semibold mt-0.5 ${
                  c.pos === null ? 'text-slate-200' : c.pos ? 'text-emerald-400' : 'text-rose-400'
                }`}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* Equity curve */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <h3 className="text-sm font-medium text-slate-300 mb-3">Equity Curve</h3>
            <EquityCurveChart data={r.equityCurve ?? []} />
          </div>

          {/* Monthly breakdown */}
          {r.monthlyBreakdown?.length > 0 && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Monthly Breakdown</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-slate-800">
                      {['Month','Trades','Win Rate','P&L'].map(h => (
                        <th key={h} className="pb-2 pr-6 font-medium">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {r.monthlyBreakdown.map((m: any) => (
                      <tr key={m.month} className="border-b border-slate-800/50">
                        <td className="py-2 pr-6 font-medium">{m.month}</td>
                        <td className="py-2 pr-6">{m.trades}</td>
                        <td className="py-2 pr-6">{(m.winRate*100).toFixed(1)}%</td>
                        <td className={`py-2 pr-6 font-medium ${m.pnl>=0?'text-emerald-400':'text-rose-400'}`}>
                          {m.pnl>=0?'+':''}${m.pnl.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
