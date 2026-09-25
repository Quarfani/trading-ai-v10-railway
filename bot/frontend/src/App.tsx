import { useState, useEffect } from 'react';
import { API, socket } from './lib/api';
import { AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { TrendingUp, TrendingDown, Activity, Shield, Brain, AlertTriangle, CheckCircle, XCircle, RefreshCw, Zap } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────
interface Status { running: boolean; mode: string; circuitBreaker: string; performance: any; openPositions: any; }
interface Strategy { enabled: boolean; metrics: { win_rate: number; sharpe_ratio: number; rolling_win_rate: number }; }
interface RecoveryState { level: string; drawdownPct: number; volumeMultiplier: number; message: string; }

const LEVEL_COLORS: Record<string, string> = {
  GREEN: '#22c55e', YELLOW: '#eab308', ORANGE: '#f97316', RED: '#ef4444', STOP: '#7f1d1d',
};

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [status,      setStatus]      = useState<Status | null>(null);
  const [consensus,   setConsensus]   = useState<any>(null);
  const [equity,      setEquity]      = useState<any[]>([]);
  const [trades,      setTrades]      = useState<any[]>([]);
  const [recovery,    setRecovery]    = useState<RecoveryState | null>(null);
  const [journal,     setJournal]     = useState<any[]>([]);
  const [grades,      setGrades]      = useState<any>({});
  const [mlStatus,    setMlStatus]    = useState<any>(null);
  const [symScores,   setSymScores]   = useState<any[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [activeTab,   setActiveTab]   = useState<string>('overview');
  const [liveSignal,  setLiveSignal]  = useState<any>(null);

  const refresh = async () => {
    try {
      const [s, c, e, t, r, j, g, ml, ss] = await Promise.allSettled([
        API.status(), API.consensus(), API.equity(), API.trades(30),
        API.recovery(), API.journal(20), API.journalGrades(),
        API.mlStatus(), API.symbolScores(),
      ]);
      if (s.status === 'fulfilled') setStatus(s.value.data);
      if (c.status === 'fulfilled') setConsensus(c.value.data);
      if (e.status === 'fulfilled') setEquity((e.value.data?.curve ?? []).slice(-100));
      if (t.status === 'fulfilled') setTrades(t.value.data?.trades ?? []);
      if (r.status === 'fulfilled') setRecovery(r.value.data);
      if (j.status === 'fulfilled') setJournal(j.value.data?.entries ?? []);
      if (g.status === 'fulfilled') setGrades(g.value.data ?? {});
      if (ml.status === 'fulfilled') setMlStatus(ml.value.data);
      if (ss.status === 'fulfilled') setSymScores(ss.value.data?.scores ?? []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30_000);
    socket.on('signal', (sig: any) => setLiveSignal(sig));
    socket.connect();
    return () => { clearInterval(interval); socket.disconnect(); };
  }, []);

  if (loading) return (
    <div className="flex h-screen bg-gray-950 items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"/>
        <p className="text-gray-400">Loading Trading Dashboard...</p>
      </div>
    </div>
  );

  const perf    = status?.performance;
  const today   = perf?.today ?? {};
  const allTime = perf?.all ?? {};
  const winRate = ((perf?.winrate ?? 0) * 100).toFixed(1);
  const equity$ = perf?.equity?.toFixed(2) ?? '0.00';
  const stratCount = consensus?.active_count ?? 0;

  const tabs = ['overview','strategies','trades','recovery','journal','ml','symbols'];

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${status?.running ? 'bg-green-400 animate-pulse' : 'bg-red-500'}`}/>
            <h1 className="text-xl font-bold text-white">Trading Bot v8.0</h1>
            <span className="px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded text-xs font-mono">
              {status?.mode?.toUpperCase() ?? 'PAPER'}
            </span>
            {liveSignal && (
              <span className={`px-2 py-0.5 rounded text-xs font-mono animate-pulse ${liveSignal.side==='BUY'?'bg-green-900 text-green-300':'bg-red-900 text-red-300'}`}>
                🔔 {liveSignal.symbol} {liveSignal.side}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={refresh} className="p-2 rounded hover:bg-gray-800 text-gray-400 hover:text-white">
              <RefreshCw size={16}/>
            </button>
            <button onClick={() => API.emergency()} className="px-3 py-1.5 bg-red-900/50 hover:bg-red-800 border border-red-700 text-red-300 rounded text-sm">
              🛑 Emergency Stop
            </button>
          </div>
        </div>
        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-4 flex gap-1 pb-0 overflow-x-auto">
          {tabs.map(t => (
            <button key={t} onClick={() => setActiveTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                activeTab === t
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>{t}</button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── OVERVIEW TAB ─────────────────────────────────────────────── */}
        {activeTab === 'overview' && <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Equity', value: `$${equity$}`, icon: <TrendingUp size={20}/>, color: 'text-green-400' },
              { label: 'Win Rate', value: `${winRate}%`, icon: <Activity size={20}/>, color: Number(winRate)>=52?'text-green-400':'text-yellow-400' },
              { label: 'Today P/L', value: `$${(today.pnl??0).toFixed(2)}`, icon: <Zap size={20}/>, color: (today.pnl??0)>=0?'text-green-400':'text-red-400' },
              { label: 'Strategies', value: `${stratCount}/8`, icon: <Brain size={20}/>, color: 'text-blue-400' },
            ].map(k => (
              <div key={k.label} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-gray-400 text-sm">{k.label}</span>
                  <span className={k.color}>{k.icon}</span>
                </div>
                <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
              </div>
            ))}
          </div>

          {/* Equity Curve */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">Equity Curve</h2>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={equity}>
                <defs>
                  <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937"/>
                <XAxis dataKey="t" tickFormatter={v => new Date(v).toLocaleDateString()} stroke="#4b5563" tick={{fontSize:11}}/>
                <YAxis stroke="#4b5563" tick={{fontSize:11}} tickFormatter={v=>`$${v.toFixed(0)}`}/>
                <Tooltip formatter={(v: any) => [`$${v.toFixed(2)}`, 'Equity']}
                  contentStyle={{background:'#111827',border:'1px solid #374151',borderRadius:8}}/>
                <Area type="monotone" dataKey="equity" stroke="#3b82f6" fill="url(#eq)" strokeWidth={2}/>
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Recovery Level */}
          {recovery && (
            <div className="bg-gray-900 border rounded-xl p-4" style={{borderColor: LEVEL_COLORS[recovery.level]+'44'}}>
              <div className="flex items-center gap-3">
                <Shield size={20} style={{color: LEVEL_COLORS[recovery.level]}}/>
                <div>
                  <span className="font-semibold" style={{color: LEVEL_COLORS[recovery.level]}}>
                    Recovery Mode: {recovery.level}
                  </span>
                  <p className="text-gray-400 text-sm">{recovery.message}</p>
                </div>
                <span className="ml-auto text-gray-300 font-mono">
                  DD: {(recovery.drawdownPct*100).toFixed(2)}% | Vol: ×{recovery.volumeMultiplier}
                </span>
              </div>
            </div>
          )}

          {/* Open Positions */}
          {status?.openPositions && Object.keys(status.openPositions).length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Open Positions</h2>
              <div className="space-y-2">
                {Object.entries(status.openPositions).map(([sym, p]: [string, any]) => (
                  <div key={sym} className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2">
                    <span className="font-mono font-semibold">{sym}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-mono ${p.side==='BUY'?'bg-green-900/50 text-green-300':'bg-red-900/50 text-red-300'}`}>{p.side}</span>
                    <span className="text-gray-400 text-sm">{p.source}</span>
                    <span className="text-gray-500 text-xs">{new Date(p.openedAt).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>}

        {/* ── STRATEGIES TAB ───────────────────────────────────────────── */}
        {activeTab === 'strategies' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">Strategy Performance</h2>
            <div className="space-y-3">
              {Object.entries(consensus?.strategies ?? {}).map(([name, s]: [string, any]) => {
                const wr = (s.metrics?.win_rate ?? 0.5) * 100;
                const sh = s.metrics?.sharpe_ratio ?? 0;
                return (
                  <div key={name} className="bg-gray-800 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        {s.enabled ? <CheckCircle size={16} className="text-green-400"/> : <XCircle size={16} className="text-red-400"/>}
                        <span className="font-mono font-semibold">{name}</span>
                      </div>
                      <div className="flex gap-4 text-sm">
                        <span className={wr >= 52 ? 'text-green-400' : 'text-yellow-400'}>WR: {wr.toFixed(1)}%</span>
                        <span className={sh >= 0.8 ? 'text-green-400' : 'text-gray-400'}>Sharpe: {sh.toFixed(2)}</span>
                        <span className="text-gray-400">Trades: {s.metrics?.total_trades ?? 0}</span>
                      </div>
                    </div>
                    {/* Win rate bar */}
                    <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500 transition-all"
                        style={{width: `${Math.min(100, wr)}%`}}/>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── TRADES TAB ───────────────────────────────────────────────── */}
        {activeTab === 'trades' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">Recent Trades</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2 px-3">Symbol</th>
                    <th className="text-left py-2 px-3">Side</th>
                    <th className="text-right py-2 px-3">Entry</th>
                    <th className="text-right py-2 px-3">P/L</th>
                    <th className="text-left py-2 px-3">Source</th>
                    <th className="text-left py-2 px-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t: any, i: number) => (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                      <td className="py-2 px-3 font-mono font-semibold">{t.symbol}</td>
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-xs ${t.side==='BUY'?'bg-green-900/40 text-green-300':'bg-red-900/40 text-red-300'}`}>{t.side}</span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{t.entry?.toFixed(5)}</td>
                      <td className={`py-2 px-3 text-right font-mono font-semibold ${(t.profit??0)>=0?'text-green-400':'text-red-400'}`}>
                        {t.profit != null ? `${t.profit>=0?'+':''}$${t.profit.toFixed(2)}` : '—'}
                      </td>
                      <td className="py-2 px-3 text-gray-400 text-xs">{t.source?.split('+')?.[0]}</td>
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-xs ${t.status==='open'?'bg-blue-900/40 text-blue-300':'bg-gray-800 text-gray-400'}`}>{t.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── RECOVERY TAB ─────────────────────────────────────────────── */}
        {activeTab === 'recovery' && recovery && (
          <div className="space-y-6">
            <div className="bg-gray-900 border rounded-xl p-6" style={{borderColor:LEVEL_COLORS[recovery.level]+'66'}}>
              <h2 className="text-2xl font-bold mb-2" style={{color:LEVEL_COLORS[recovery.level]}}>
                {recovery.level} MODE
              </h2>
              <p className="text-gray-300 mb-4">{recovery.message}</p>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Drawdown', value: `${(recovery.drawdownPct*100).toFixed(2)}%` },
                  { label: 'Vol Multiplier', value: `×${recovery.volumeMultiplier}` },
                ].map(k => (
                  <div key={k.label} className="bg-gray-800 rounded-lg p-3">
                    <p className="text-gray-500 text-sm">{k.label}</p>
                    <p className="text-xl font-bold">{k.value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── JOURNAL TAB ──────────────────────────────────────────────── */}
        {activeTab === 'journal' && (
          <div className="space-y-6">
            {/* Grade distribution */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Grade Distribution</h2>
              <div className="flex gap-4">
                {Object.entries(grades).map(([g, cnt]: [string, any]) => (
                  <div key={g} className="flex-1 text-center bg-gray-800 rounded-lg p-3">
                    <p className="text-2xl font-bold">{cnt}</p>
                    <p className="text-gray-400 text-sm">Grade {g}</p>
                  </div>
                ))}
              </div>
            </div>
            {/* Journal entries */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">Recent Journal Entries</h2>
              <div className="space-y-3">
                {journal.map((e: any, i: number) => (
                  <div key={i} className="bg-gray-800 rounded-lg p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono font-semibold">{e.symbol} {e.side} #{e.tradeId}</span>
                      <div className="flex gap-2">
                        <span className="font-bold text-lg">{e.grade}</span>
                        <span className={`font-semibold ${(e.profit??0)>=0?'text-green-400':'text-red-400'}`}>
                          ${(e.profit??0).toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <p className="text-gray-400 text-sm">{e.lesson}</p>
                    {e.patternMatch && <p className="text-blue-400 text-xs mt-1">{e.patternMatch}</p>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── ML TAB ───────────────────────────────────────────────────── */}
        {activeTab === 'ml' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">ML Model Status</h2>
              <button onClick={() => API.mlTrain()}
                className="px-4 py-2 bg-blue-900/50 hover:bg-blue-800 border border-blue-700 rounded-lg text-sm text-blue-300">
                🔄 Retrain Model
              </button>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-500 text-sm">Status</p>
                <p className={`text-xl font-bold ${mlStatus?.trained?'text-green-400':'text-yellow-400'}`}>
                  {mlStatus?.trained ? '✅ Trained' : '⏳ Not trained'}
                </p>
              </div>
            </div>
            {mlStatus?.importance && (
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-3">Feature Importance</h3>
                <div className="space-y-2">
                  {Object.entries(mlStatus.importance).sort(([,a]:any,[,b]:any)=>b-a).slice(0,8).map(([feat, imp]: any) => (
                    <div key={feat} className="flex items-center gap-3">
                      <span className="text-gray-400 text-xs w-32 truncate">{feat}</span>
                      <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full" style={{width:`${Math.min(100,(imp/0.1)*100)}%`}}/>
                      </div>
                      <span className="text-gray-500 text-xs w-12 text-right">{(imp*100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SYMBOLS TAB ──────────────────────────────────────────────── */}
        {activeTab === 'symbols' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">Symbol Scores</h2>
            <div className="space-y-2">
              {symScores.filter(Boolean).map((s: any) => (
                <div key={s.symbol} className="flex items-center gap-4 bg-gray-800 rounded-lg px-4 py-2">
                  <span className={`w-3 h-3 rounded-full ${s.suitable?'bg-green-400':'bg-gray-600'}`}/>
                  <span className="font-mono font-semibold w-20">{s.symbol}</span>
                  <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${s.suitable?'bg-green-500':'bg-gray-500'}`}
                      style={{width:`${s.score}%`}}/>
                  </div>
                  <span className="text-gray-300 w-8 text-right font-mono">{s.score}</span>
                  <span className="text-gray-500 text-xs w-64 truncate">{s.reason}</span>
                </div>
              ))}
              {!symScores.length && <p className="text-gray-500 text-center py-8">Run auto-discovery to see symbol scores</p>}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
