interface Signal { symbol:string;side:string;confidence:number;source:string;reason:string;price:number;timestamp:number;regime?:string;quality?:number }
interface Props  { signals: Signal[] }
export function SignalFeed({ signals }: Props) {
  if (!signals.length) return <p className="text-slate-500 text-sm">No signals yet</p>;
  return (
    <div className="space-y-2 max-h-[600px] overflow-y-auto pr-1">
      {signals.map((s, i) => (
        <div key={i} className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-slate-200">{s.symbol}</span>
              <span className={`text-xs font-bold px-2 py-0.5 rounded ${s.side==='BUY'?'bg-emerald-900 text-emerald-300':'bg-rose-900 text-rose-300'}`}>
                {s.side}
              </span>
              {s.regime && (
                <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300">{s.regime}</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-400">
              {s.quality != null && (
                <span className={`font-medium ${s.quality>=65?'text-emerald-400':s.quality>=50?'text-amber-400':'text-rose-400'}`}>
                  Q:{s.quality}
                </span>
              )}
              <span>{(s.confidence * 100).toFixed(0)}% conf</span>
              <span className="text-slate-500">{new Date(s.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
          <div className="text-xs text-slate-400 flex gap-4">
            <span>@ {s.price?.toFixed(5)}</span>
            <span className="text-slate-500">{s.source}</span>
          </div>
          {s.reason && <div className="text-xs text-slate-500 mt-1 truncate">{s.reason}</div>}
        </div>
      ))}
    </div>
  );
}
