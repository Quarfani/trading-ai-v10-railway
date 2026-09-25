interface Props { regimes: Record<string, any> }
const COLOR: Record<string, string> = {
  TRENDING: 'bg-emerald-900 text-emerald-300 border-emerald-700',
  RANGING:  'bg-blue-900 text-blue-300 border-blue-700',
  VOLATILE: 'bg-rose-900 text-rose-300 border-rose-700',
  UNKNOWN:  'bg-slate-800 text-slate-400 border-slate-700',
};
const EMOJI: Record<string, string> = { TRENDING:'📈', RANGING:'↔️', VOLATILE:'⚡', UNKNOWN:'❓' };

export function RegimePanel({ regimes }: Props) {
  const entries = Object.entries(regimes);
  if (!entries.length)
    return <div className="bg-slate-900 rounded-xl border border-slate-800 p-6 text-slate-500 text-sm">No regime data yet — start the bot first</div>;

  // Group by symbol
  const bySymbol: Record<string, any[]> = {};
  for (const [key, val] of entries) {
    const [sym] = key.split('_');
    if (!bySymbol[sym]) bySymbol[sym] = [];
    bySymbol[sym].push({ tf: key.split('_')[1], ...val });
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-slate-300">🌊 Market Regimes</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Object.entries(bySymbol).map(([sym, tfs]) => (
          <div key={sym} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="font-semibold text-slate-200 mb-3">{sym}</div>
            <div className="space-y-2">
              {tfs.map(r => (
                <div key={r.tf} className={`flex items-center justify-between text-xs border rounded-lg px-3 py-2 ${COLOR[r.regime] ?? COLOR.UNKNOWN}`}>
                  <span className="font-medium">{r.tf}</span>
                  <span>{EMOJI[r.regime]} {r.regime}</span>
                  <span className="opacity-70">ADX {r.adx?.toFixed(1) ?? '—'}</span>
                  <span className="opacity-70">{r.trend}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">Refreshes every 30 seconds</p>
    </div>
  );
}
