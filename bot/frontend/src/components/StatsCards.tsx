interface Props { status: any }
export function StatsCards({ status }: Props) {
  const t = status?.performance?.today ?? {};
  const a = status?.performance?.all ?? {};
  const wr = ((status?.performance?.winrate ?? 0) * 100).toFixed(1);

  const cards = [
    { label: "Today's P&L",   value: `${(t.pnl??0)>=0?'+':''}$${(t.pnl??0).toFixed(2)}`, color: (t.pnl??0)>=0?'text-emerald-400':'text-rose-400' },
    { label: 'Today Trades',  value: String(t.trades ?? 0), color: 'text-slate-200' },
    { label: 'Win Rate',      value: `${wr}%`, color: Number(wr)>=50?'text-emerald-400':'text-amber-400' },
    { label: 'Total P&L',     value: `${(a.totalPnl??0)>=0?'+':''}$${(a.totalPnl??0).toFixed(2)}`, color: (a.totalPnl??0)>=0?'text-emerald-400':'text-rose-400' },
    { label: 'Total Trades',  value: String(a.total ?? 0), color: 'text-slate-200' },
    { label: 'Wins / Losses', value: `${a.wins??0} / ${a.losses??0}`, color: 'text-slate-200' },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map(c => (
        <div key={c.label} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">{c.label}</div>
          <div className={`text-lg font-semibold ${c.color}`}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}
