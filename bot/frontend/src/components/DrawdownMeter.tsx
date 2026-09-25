interface Props { ddStatus: any }
export function DrawdownMeter({ ddStatus }: Props) {
  if (!ddStatus) return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="text-xs text-slate-400 mb-1">Drawdown</div>
      <div className="text-slate-500 text-sm">Loading...</div>
    </div>
  );

  const dd  = ((ddStatus.drawdownPct ?? 0) * 100);
  const pct = Math.min(100, dd * 10); // 10% DD = 100% bar

  const colors: Record<string, string> = {
    NORMAL:   'bg-emerald-500',
    WARNING:  'bg-amber-500',
    DANGER:   'bg-orange-500',
    CRITICAL: 'bg-rose-500',
    STOP:     'bg-red-700',
  };
  const levelColors: Record<string, string> = {
    NORMAL:   'text-emerald-400',
    WARNING:  'text-amber-400',
    DANGER:   'text-orange-400',
    CRITICAL: 'text-rose-400',
    STOP:     'text-red-400',
  };
  const barColor = colors[ddStatus.level] ?? 'bg-slate-500';
  const lvlColor = levelColors[ddStatus.level] ?? 'text-slate-400';

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex justify-between items-center mb-2">
        <div className="text-xs text-slate-400">Drawdown</div>
        <div className={`text-xs font-semibold ${lvlColor}`}>{ddStatus.level}</div>
      </div>
      <div className="bg-slate-800 rounded-full h-2 mb-3">
        <div className={`h-2 rounded-full transition-all ${barColor}`}
             style={{ width: `${pct}%` }} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div><span className="text-slate-400">Current DD: </span><span className="font-medium">{dd.toFixed(2)}%</span></div>
        <div><span className="text-slate-400">Vol Scale: </span><span className="font-medium">{((ddStatus.volumeScale??1)*100).toFixed(0)}%</span></div>
        <div><span className="text-slate-400">Peak: </span><span className="font-medium">${(ddStatus.peakEquity??0).toFixed(0)}</span></div>
        <div><span className="text-slate-400">Current: </span><span className="font-medium">${(ddStatus.currentEquity??0).toFixed(0)}</span></div>
      </div>
      {ddStatus.level === 'STOP' && (
        <div className="mt-3 text-xs bg-red-950 border border-red-800 rounded-lg px-3 py-2 text-red-300">
          🛑 Trading STOPPED — drawdown ≥ 10%
        </div>
      )}
    </div>
  );
}
