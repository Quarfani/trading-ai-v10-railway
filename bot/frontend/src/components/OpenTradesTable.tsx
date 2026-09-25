interface Trade { id:number;symbol:string;side:string;volume:number;entry:number;sl:number;tp:number;openedAt:number;source:string;timeframe?:string }
interface Props  { trades: Trade[]; detailed?: boolean }

export function OpenTradesTable({ trades, detailed }: Props) {
  if (!trades.length) return <p className="text-slate-500 text-sm">No open trades</p>;
  const now = Date.now();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-400 border-b border-slate-800">
            {['Symbol','Side','Vol','Entry','SL','TP',
              ...(detailed ? ['TF','Source','Age'] : [])
            ].map(h => <th key={h} className="pb-2 pr-4 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {trades.map(t => {
            const ageMs  = now - t.openedAt;
            const ageStr = ageMs > 3_600_000
              ? `${(ageMs/3_600_000).toFixed(1)}h`
              : `${Math.floor(ageMs/60_000)}m`;
            const slDist = Math.abs(t.entry - t.sl);
            const tpDist = Math.abs(t.tp - t.entry);
            const rr     = slDist > 0 ? (tpDist / slDist).toFixed(1) : '—';
            return (
              <tr key={t.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                <td className="py-2 pr-4 font-medium">{t.symbol}</td>
                <td className={`py-2 pr-4 font-semibold ${t.side==='BUY'?'text-emerald-400':'text-rose-400'}`}>{t.side}</td>
                <td className="py-2 pr-4">{t.volume}</td>
                <td className="py-2 pr-4">{t.entry?.toFixed(5)}</td>
                <td className="py-2 pr-4 text-rose-300">{t.sl?.toFixed(5)}</td>
                <td className="py-2 pr-4 text-emerald-300">{t.tp?.toFixed(5)} <span className="text-xs text-slate-500">({rr}R)</span></td>
                {detailed && <>
                  <td className="py-2 pr-4 text-slate-400 text-xs">{t.timeframe ?? '—'}</td>
                  <td className="py-2 pr-4 text-slate-400 text-xs">{t.source}</td>
                  <td className="py-2 pr-4 text-amber-400 text-xs">{ageStr}</td>
                </>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
