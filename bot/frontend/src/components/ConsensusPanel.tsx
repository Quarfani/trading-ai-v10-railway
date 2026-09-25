/**
 * CONSENSUS PANEL — Frontend component
 * Shows live strategy registry status, performance gates, and conflict log
 */
import { useEffect, useState } from 'react';
import { api } from '../api';

interface StrategyStatus {
  name: string;
  metrics: {
    win_rate: number; sharpe_ratio: number; max_drawdown: number;
    expectancy: number; rolling_win_rate: number; rolling_expectancy: number;
    total_trades: number; rolling_trades: number;
  };
}
interface ConsensusStatus {
  active_count:   number;
  disabled_count: number;
  active:         StrategyStatus[];
  disabled:       Array<{ name: string; reason: string; disabledAt: number }>;
  conflict_rate:  { total: number; conflicts: number; rate: number };
}
interface LogEntry {
  id: number; symbol: string; outcome: string; block_reason: string;
  buy_weight: number; sell_weight: number; dominance: number;
  active_strats: number; voters: number; duration_ms: number; timestamp: number;
}

const OUTCOME_COLOR: Record<string, string> = {
  BUY:      'text-emerald-400', SELL:     'text-rose-400',
  NO_TRADE: 'text-slate-400',
};
const REASON_COLOR: Record<string, string> = {
  APPROVED:                     'text-emerald-400',
  CONFLICT_BLOCKED:             'text-red-400',
  INSUFFICIENT_WEIGHT:          'text-amber-400',
  LOW_DOMINANCE:                'text-amber-400',
  NO_ACTIVE_STRATEGIES:         'text-rose-400',
  SINGLE_STRATEGY_LOW_CONFIDENCE: 'text-amber-300',
  PERFORMANCE_GATE_FAILED:      'text-orange-400',
};

export function ConsensusPanel() {
  const [status, setStatus] = useState<ConsensusStatus | null>(null);
  const [log,    setLog]    = useState<LogEntry[]>([]);
  const [tab,    setTab]    = useState<'status'|'log'>('status');

  useEffect(() => {
    const load = async () => {
      try {
        const [s, l] = await Promise.all([
          api.get('/consensus/status'),
          api.get('/consensus/log?limit=30'),
        ]);
        setStatus(s.data);
        setLog(l.data);
      } catch {}
    };
    load();
    const i = setInterval(load, 10_000);
    return () => clearInterval(i);
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-medium text-slate-300">🧠 Consensus Engine</h2>
        {status && (
          <div className="flex gap-3 text-xs text-slate-400">
            <span className="text-emerald-400">{status.active_count} active</span>
            {status.disabled_count > 0 && (
              <span className="text-amber-400">{status.disabled_count} disabled</span>
            )}
            <span>Conflicts 24h: {(status.conflict_rate.rate * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {(['status','log'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-2 text-sm border-b-2 transition ${
                    tab === t ? 'border-blue-500 text-blue-400' : 'border-transparent text-slate-400'
                  }`}>
            {t === 'status' ? '⚙️ Strategies' : '📋 Decision Log'}
          </button>
        ))}
      </div>

      {tab === 'status' && status && (
        <div className="space-y-4">
          {/* Active strategies */}
          {status.active.map(s => (
            <div key={s.name} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="font-medium text-slate-200">{s.name}</span>
                </div>
                <span className="text-xs text-emerald-400 bg-emerald-900/50 px-2 py-0.5 rounded-full">ACTIVE</span>
              </div>
              <div className="grid grid-cols-4 gap-3 text-xs">
                {[
                  { label: 'Win Rate',    val: `${(s.metrics.win_rate*100).toFixed(1)}%`,        ok: s.metrics.win_rate >= 0.5 },
                  { label: 'Sharpe',      val: s.metrics.sharpe_ratio.toFixed(2),                ok: s.metrics.sharpe_ratio >= 1 },
                  { label: 'Roll WR',     val: `${(s.metrics.rolling_win_rate*100).toFixed(1)}%`, ok: s.metrics.rolling_win_rate >= 0.5 },
                  { label: 'Expectancy',  val: `$${s.metrics.expectancy.toFixed(2)}`,            ok: s.metrics.expectancy >= 0 },
                  { label: 'Max DD',      val: `${(s.metrics.max_drawdown*100).toFixed(1)}%`,    ok: s.metrics.max_drawdown < 0.2 },
                  { label: 'Roll Exp',    val: `$${s.metrics.rolling_expectancy.toFixed(2)}`,   ok: s.metrics.rolling_expectancy >= 0 },
                  { label: 'Trades',      val: String(s.metrics.total_trades),                   ok: true },
                  { label: 'Roll Trades', val: String(s.metrics.rolling_trades),                 ok: true },
                ].map(m => (
                  <div key={m.label} className="bg-slate-800 rounded-lg px-2 py-1.5">
                    <div className="text-slate-400 mb-0.5">{m.label}</div>
                    <div className={m.ok ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>{m.val}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Disabled strategies */}
          {status.disabled.map(d => (
            <div key={d.name} className="bg-slate-900 border border-rose-900/50 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-rose-400" />
                  <span className="font-medium text-slate-400">{d.name}</span>
                </div>
                <span className="text-xs text-rose-400 bg-rose-900/50 px-2 py-0.5 rounded-full">DISABLED</span>
              </div>
              <div className="text-xs text-slate-500 font-mono">{d.reason}</div>
              <div className="text-xs text-slate-600 mt-1">
                {new Date(d.disabledAt).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'log' && (
        <div className="space-y-2 max-h-[600px] overflow-y-auto">
          {log.length === 0 && (
            <p className="text-slate-500 text-sm">No decisions logged yet</p>
          )}
          {log.map(e => (
            <div key={e.id} className={`border rounded-lg px-4 py-3 text-sm ${
              e.block_reason === 'APPROVED'
                ? 'bg-emerald-950/30 border-emerald-900/40'
                : e.block_reason === 'CONFLICT_BLOCKED'
                ? 'bg-red-950/30 border-red-900/40'
                : 'bg-slate-900 border-slate-800'
            }`}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`font-semibold ${OUTCOME_COLOR[e.outcome] ?? 'text-slate-300'}`}>
                    {e.outcome}
                  </span>
                  <span className="text-slate-300 font-medium">{e.symbol}</span>
                  <span className={`text-xs ${REASON_COLOR[e.block_reason] ?? 'text-slate-400'}`}>
                    {e.block_reason}
                  </span>
                </div>
                <span className="text-xs text-slate-500">
                  {new Date(e.timestamp).toLocaleTimeString()}
                </span>
              </div>
              {e.block_reason === 'APPROVED' && (
                <div className="flex gap-4 mt-1.5 text-xs text-slate-400">
                  <span>voters={e.voters}</span>
                  <span>dom={e.dominance?.toFixed(2)}</span>
                  <span>w↑={e.buy_weight?.toFixed(4)}</span>
                  <span>w↓={e.sell_weight?.toFixed(4)}</span>
                  <span>{e.duration_ms}ms</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
