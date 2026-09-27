import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Brain,
  ChevronRight,
  CircleDollarSign,
  Cloud,
  CloudCog,
  Database,
  Gauge,
  LayoutDashboard,
  LineChart,
  ListFilter,
  LogOut,
  Menu,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  X,
  Zap,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { API, socket } from './lib/api';

type TabId = 'overview' | 'trading' | 'strategies' | 'risk' | 'performance' | 'storage' | 'ml' | 'symbols' | 'logs';

type Signal = {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  confidence?: number;
  sl?: number;
  tp?: number;
  source?: string;
  reason?: string;
  timestamp?: number;
};

type StrategySnapshot = {
  enabled: boolean;
  metrics?: {
    win_rate?: number;
    sharpe_ratio?: number;
    rolling_win_rate?: number;
    total_trades?: number;
    expectancy?: number;
  };
};

type MarketRow = {
  symbol: string;
  price: number | null;
  regime: string;
  signal: Signal | null;
  spread?: number | null;
};

type StorageStatus = {
  mega?: {
    enabled?: boolean;
    credentialsPresent?: boolean;
    mode?: string;
    folder?: string;
    note?: string;
  };
};

const NAV: { id: TabId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'trading', label: 'Trading', icon: Zap },
  { id: 'strategies', label: 'Strategies', icon: SlidersHorizontal },
  { id: 'risk', label: 'Risk Management', icon: Shield },
  { id: 'performance', label: 'Performance', icon: LineChart },
  { id: 'storage', label: 'Storage & Recovery', icon: CloudCog },
  { id: 'ml', label: 'ML / AI', icon: Brain },
  { id: 'symbols', label: 'Symbols', icon: ListFilter },
  { id: 'logs', label: 'Logs', icon: Database },
];

const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n: number) => `${n.toFixed(1)}%`;
const fmtPrice = (n: number | null) => n == null ? '—' : n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toLocaleString(undefined, { maximumFractionDigits: 5 });
const timeAgo = (ts?: number) => {
  if (!ts) return '—';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h`;
};

function StatusDot({ live = true }: { live?: boolean }) {
  return <span className={`status-dot ${live ? 'live' : 'offline'}`} />;
}

function Panel({ title, subtitle, right, children, className = '' }: { title: string; subtitle?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-header">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function KpiCard({ label, value, meta, icon, tone = 'blue' }: { label: string; value: string; meta?: string; icon: ReactNode; tone?: 'blue' | 'green' | 'red' | 'purple' | 'amber' }) {
  return (
    <article className="kpi-card">
      <div className={`kpi-icon ${tone}`}>{icon}</div>
      <div className="kpi-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        {meta && <small>{meta}</small>}
      </div>
    </article>
  );
}

function SignalBadge({ side }: { side: 'BUY' | 'SELL' }) {
  return <span className={`badge ${side === 'BUY' ? 'green' : 'red'}`}>{side}</span>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lastSync, setLastSync] = useState(Date.now());
  const [status, setStatus] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [consensus, setConsensus] = useState<any>(null);
  const [equity, setEquity] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [openTrades, setOpenTrades] = useState<any[]>([]);
  const [recovery, setRecovery] = useState<any>(null);
  const [grades, setGrades] = useState<Record<string, number>>({});
  const [journal, setJournal] = useState<any[]>([]);
  const [mlStatus, setMlStatus] = useState<any>(null);
  const [symbolScores, setSymbolScores] = useState<any[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [paperStats, setPaperStats] = useState<any>(null);
  const [heatmap, setHeatmap] = useState<any>(null);
  const [v9Status, setV9Status] = useState<any>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [marketRows, setMarketRows] = useState<MarketRow[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [liveSignal, setLiveSignal] = useState<Signal | null>(null);
  const [query, setQuery] = useState('');

  const refresh = async () => {
    setError('');
    try {
      const results = await Promise.allSettled([
        API.status(),
        API.health(),
        API.consensus(),
        API.equity(),
        API.trades(60),
        API.openTrades(),
        API.recovery(),
        API.journal(30),
        API.journalGrades(),
        API.mlStatus(),
        API.symbolScores(),
        API.signals(80),
        API.paperStats(),
        API.heatmap(),
        API.v9Status(),
        API.symbols(),
        API.storageStatus(),
      ]);

      const pick = <T,>(i: number): T | null => results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<any>).value.data : null;
      const s = pick<any>(0);
      const h = pick<any>(1);
      const c = pick<any>(2);
      const e = pick<any>(3);
      const t = pick<any>(4);
      const ot = pick<any>(5);
      const r = pick<any>(6);
      const j = pick<any>(7);
      const g = pick<any>(8);
      const ml = pick<any>(9);
      const ss = pick<any>(10);
      const sg = pick<any>(11);
      const ps = pick<any>(12);
      const hm = pick<any>(13);
      const v9 = pick<any>(14);
      const sy = pick<any>(15);
      const st = pick<any>(16);

      if (s) setStatus(s);
      if (h) setHealth(h);
      if (c) setConsensus(c);
      if (e) setEquity((e.curve ?? []).slice(-180));
      if (t) setTrades(t.trades ?? []);
      if (ot) setOpenTrades(ot.trades ?? []);
      if (r) setRecovery(r);
      if (j) setJournal(j.entries ?? []);
      if (g) setGrades(g);
      if (ml) setMlStatus(ml);
      if (ss) setSymbolScores(ss.scores ?? []);
      if (sg) setSignals(sg.signals ?? []);
      if (ps) setPaperStats(ps);
      if (hm) setHeatmap(hm);
      if (v9) setV9Status(v9);
      if (sy) setSymbols(sy.symbols ?? []);
      if (st) setStorage(st);

      const baseSymbols = (sy?.symbols ?? symbols ?? []) as string[];
      const latestBySymbol = new Map<string, Signal>();
      for (const signal of (sg?.signals ?? []) as Signal[]) {
        if (!latestBySymbol.has(signal.symbol)) latestBySymbol.set(signal.symbol, signal);
      }

      const regimes = await Promise.all(baseSymbols.slice(0, 30).map(async symbol => {
        try {
          const result = await API.regime(symbol);
          return [symbol, result.data?.regime ?? 'UNKNOWN'] as const;
        } catch {
          return [symbol, 'UNKNOWN'] as const;
        }
      }));
      const regimeMap = new Map(regimes);
      const rows = baseSymbols.map(symbol => ({
        symbol,
        price: latestBySymbol.get(symbol)?.price ?? null,
        regime: regimeMap.get(symbol) ?? 'UNKNOWN',
        signal: latestBySymbol.get(symbol) ?? null,
      }));
      setMarketRows(rows);
      setLastSync(Date.now());
    } catch (e: any) {
      setError(e?.message ?? 'Dashboard refresh failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 30_000);
    const onSignal = (signal: Signal) => setLiveSignal(signal);
    socket.on('signal', onSignal);
    socket.connect();
    return () => {
      window.clearInterval(interval);
      socket.off('signal', onSignal);
      socket.disconnect();
    };
  }, []);

  const perf = status?.performance ?? {};
  const today = perf?.today ?? {};
  const all = perf?.all ?? {};
  const balance = Number(paperStats?.balance ?? perf?.equity ?? 0);
  const winRate = Number(paperStats?.winRate ?? perf?.winrate ?? 0) * 100;
  const todayPnl = Number(today?.pnl ?? 0);
  const allPnl = Number(all?.totalPnl ?? paperStats?.totalPnl ?? 0);
  const drawdown = Number(recovery?.drawdownPct ?? (paperStats?.maxDrawdownPct ?? 0) / 100) * 100;
  const activeStrategies = Number(consensus?.active_count ?? 0);
  const totalStrategies = Number(consensus?.total_count ?? 0);
  const running = Boolean(status?.running ?? health?.running);

  const visibleSignals = useMemo(() => {
    if (!query.trim()) return signals.slice(0, 12);
    const q = query.toLowerCase();
    return signals.filter(s => `${s.symbol} ${s.side} ${s.source ?? ''}`.toLowerCase().includes(q)).slice(0, 12);
  }, [signals, query]);

  const recentTrades = useMemo(() => trades.slice(0, 10), [trades]);

  const strategyCards = useMemo(() => {
    return Object.entries((consensus?.strategies ?? {}) as Record<string, StrategySnapshot>)
      .map(([name, snapshot]) => ({
        name,
        enabled: Boolean(snapshot.enabled),
        wr: Number(snapshot.metrics?.win_rate ?? 0.5) * 100,
        sharpe: Number(snapshot.metrics?.sharpe_ratio ?? 0),
        trades: Number(snapshot.metrics?.total_trades ?? 0),
        expectancy: Number(snapshot.metrics?.expectancy ?? 0),
      }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.wr - a.wr);
  }, [consensus]);

  const doControl = async (action: 'start' | 'stop' | 'emergency') => {
    setBusy(true);
    try {
      if (action === 'emergency') {
        const confirmed = window.confirm('Activate the emergency stop? Trading will be blocked until resumed by an authorized operator.');
        if (!confirmed) return;
        await API.emergency();
      } else if (action === 'start') {
        await API.start();
      } else {
        await API.stop();
      }
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Control action failed');
    } finally {
      setBusy(false);
    }
  };

  const chartData = equity.map((point: any) => ({
    time: point.t ?? point.time,
    equity: Number(point.equity ?? 0),
  }));

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-mark"><Activity size={28} /></div>
        <div>
          <strong>Trading AI v10</strong>
          <p>Connecting to the trading core…</p>
        </div>
      </div>
    );
  }

  const pageTitle = NAV.find(item => item.id === activeTab)?.label ?? 'Overview';

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><TrendingUp size={22} /></div>
          <div>
            <strong>Trading AI v10</strong>
            <span>Multi-Strategy Trading Core</span>
          </div>
          <button className="icon-button mobile-close" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>

        <nav className="nav-list">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} className={`nav-item ${activeTab === id ? 'active' : ''}`} onClick={() => { setActiveTab(id); setSidebarOpen(false); }}>
              <Icon size={18} />
              <span>{label}</span>
              {id === 'logs' && visibleSignals.length > 0 && <span className="nav-count">{Math.min(9, visibleSignals.length)}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="runtime-card">
            <div className="runtime-head"><StatusDot live={running} /><span>{running ? 'Bot Running' : 'Bot Stopped'}</span></div>
            <small>v10.0 • {status?.mode?.toUpperCase() ?? 'PAPER'} mode</small>
          </div>
          <div className="sidebar-meta"><Database size={14} /> SQLite runtime state</div>
          <div className="sidebar-meta"><Cloud size={14} /> MEGA archive / DR</div>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button menu-button" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
            <div>
              <h1>{pageTitle}</h1>
              <p>Real-time control room • paper-first risk environment</p>
            </div>
          </div>

          <div className="topbar-right">
            <div className="mode-pill"><span className="mode-dot" /> {status?.mode?.toUpperCase() ?? 'PAPER'}</div>
            <div className="market-pill"><StatusDot live={running} /> {running ? 'Engine Online' : 'Engine Offline'}</div>
            <div className={`storage-pill ${storage?.mega?.enabled ? 'ready' : ''}`}><Cloud size={14} /> {storage?.mega?.enabled ? 'MEGA Ready' : 'MEGA External'}</div>
            <div className="topbar-time">Updated {timeAgo(lastSync)} ago</div>
            <button className="top-emergency" disabled={busy} onClick={() => doControl('emergency')}><AlertTriangle size={15} /> Emergency Stop</button>
            <button className="icon-button" title="Refresh" onClick={refresh}><RefreshCw size={17} /></button>
            <button className="icon-button" title="Notifications"><Bell size={17} /></button>
            <button className="icon-button" title="Settings" onClick={() => setActiveTab('storage')}><Settings size={17} /></button>
            <div className="avatar">AI</div>
          </div>
        </header>

        {error && (
          <div className="alert-banner">
            <AlertTriangle size={18} />
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError('')}><X size={16} /></button>
          </div>
        )}

        <main className="content">
          {liveSignal && (
            <div className={`signal-banner ${liveSignal.side === 'BUY' ? 'buy' : 'sell'}`}>
              <div className="signal-banner-left"><Sparkles size={17} /><strong>Live signal</strong><SignalBadge side={liveSignal.side} /><span>{liveSignal.symbol}</span><span className="muted">{liveSignal.source ?? 'strategy'}</span></div>
              <div className="signal-banner-right">Confidence {fmtPct(Number(liveSignal.confidence ?? 0) * 100)} • {timeAgo(liveSignal.timestamp)} ago</div>
            </div>
          )}

          {activeTab === 'overview' && (
            <>
              <section className="kpi-grid">
                <KpiCard label="Equity" value={fmtMoney(balance)} meta={`${allPnl >= 0 ? '+' : ''}${fmtMoney(allPnl)} total P/L`} icon={<CircleDollarSign size={21} />} tone="blue" />
                <KpiCard label="Win Rate" value={fmtPct(winRate)} meta={`${paperStats?.wins ?? all?.wins ?? 0} wins / ${paperStats?.trades ?? all?.total ?? 0} closed`} icon={<Target size={21} />} tone="green" />
                <KpiCard label="Today P/L" value={`${todayPnl >= 0 ? '+' : ''}${fmtMoney(todayPnl)}`} meta={`${today?.trades ?? 0} trades today`} icon={<TrendingUp size={21} />} tone={todayPnl >= 0 ? 'green' : 'red'} />
                <KpiCard label="Open Trades" value={`${openTrades.length}`} meta={`${activeStrategies}/${totalStrategies || 0} strategies active`} icon={<Zap size={21} />} tone="purple" />
                <KpiCard label="Drawdown" value={fmtPct(drawdown)} meta={`Recovery ${recovery?.level ?? 'GREEN'}`} icon={<TrendingDown size={21} />} tone={drawdown > 4 ? 'red' : 'amber'} />
                <KpiCard label="Profit Factor" value={Number(paperStats?.profitFactor ?? perf?.profitFactor ?? 0).toFixed(2)} meta={`R:R avg ${Number(paperStats?.riskReward ?? 0).toFixed(2)}`} icon={<Gauge size={21} />} tone="blue" />
              </section>

              <section className="hero-grid">
                <Panel
                  title="Equity Curve"
                  subtitle="Account equity and paper-trading progression"
                  className="equity-panel"
                  right={<div className="chart-tools"><button className="active">Live</button><button>7D</button><button>30D</button></div>}
                >
                  <div className="equity-summary"><strong>{fmtMoney(balance)}</strong><span className={allPnl >= 0 ? 'positive' : 'negative'}>{allPnl >= 0 ? '+' : ''}{fmtMoney(allPnl)}</span><small>{fmtPct(winRate)} win rate</small></div>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#29d3a8" stopOpacity={0.28} />
                            <stop offset="100%" stopColor="#29d3a8" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="#15263e" vertical={false} />
                        <XAxis dataKey="time" hide />
                        <YAxis stroke="#516279" tick={{ fill: '#7e91aa', fontSize: 11 }} domain={['auto', 'auto']} tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`} width={42} />
                        <Tooltip contentStyle={{ background: '#081426', border: '1px solid #183255', borderRadius: 10, color: '#e8f2ff' }} formatter={(value: any) => [fmtMoney(Number(value)), 'Equity']} labelFormatter={() => ''} />
                        <Area type="monotone" dataKey="equity" stroke="#35d9b2" strokeWidth={2.5} fill="url(#equityFill)" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>

                <Panel title="Market Watch" subtitle="Latest symbols, regime and signal state" className="market-panel" right={<div className="panel-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search symbol…" /></div>}>
                  <div className="market-table table-scroll">
                    <div className="table-head"><span>Symbol</span><span>Price</span><span>Regime</span><span>Signal</span><span>Conf.</span><span>R:R</span></div>
                    {marketRows.filter(row => !query || row.symbol.toLowerCase().includes(query.toLowerCase())).slice(0, 10).map(row => {
                      const rr = row.signal?.sl != null && row.signal?.tp != null && row.signal?.price ? Math.abs(row.signal.tp - row.signal.price) / Math.abs(row.signal.price - row.signal.sl) : null;
                      return (
                        <div className="table-row" key={row.symbol}>
                          <span className="symbol-name"><span className="coin-dot" />{row.symbol}</span>
                          <span>{fmtPrice(row.signal?.price ?? row.price)}</span>
                          <span><span className={`regime ${row.regime.toLowerCase()}`}>{row.regime}</span></span>
                          <span>{row.signal ? <SignalBadge side={row.signal.side} /> : <span className="muted">—</span>}</span>
                          <span>{row.signal?.confidence != null ? fmtPct(row.signal.confidence * 100) : '—'}</span>
                          <span>{rr != null && Number.isFinite(rr) ? rr.toFixed(2) : '—'}</span>
                        </div>
                      );
                    })}
                    {!marketRows.length && <div className="empty-state">Waiting for market symbols…</div>}
                  </div>
                </Panel>
              </section>

              <section className="bottom-grid">
                <Panel title="Strategy Health" subtitle={`${activeStrategies}/${totalStrategies || 0} strategies participating`} className="strategy-panel" right={<button className="link-button" onClick={() => setActiveTab('strategies')}>View all <ChevronRight size={14} /></button>}>
                  <div className="strategy-grid">
                    {strategyCards.slice(0, 9).map(strategy => (
                      <article className="strategy-card" key={strategy.name}>
                        <div className="strategy-head"><span className="strategy-icon"><Sparkles size={14} /></span><strong>{strategy.name}</strong><span className={`status-badge ${strategy.enabled ? 'active' : 'blocked'}`}>{strategy.enabled ? 'ACTIVE' : 'BLOCKED'}</span></div>
                        <div className="strategy-stats"><span>WR <b>{fmtPct(strategy.wr)}</b></span><span>Sharpe <b>{strategy.sharpe.toFixed(2)}</b></span><span>Trades <b>{strategy.trades}</b></span></div>
                        <div className="meter"><span style={{ width: `${Math.min(100, Math.max(0, strategy.wr))}%` }} /></div>
                      </article>
                    ))}
                  </div>
                </Panel>

                <Panel title="Recent Trades" subtitle="Execution and paper-trading activity" className="trades-panel" right={<button className="link-button" onClick={() => setActiveTab('trading')}>View all <ChevronRight size={14} /></button>}>
                  <div className="trade-table table-scroll">
                    <div className="table-head five"><span>Time</span><span>Symbol</span><span>Side</span><span>P/L</span><span>Status</span></div>
                    {recentTrades.map((trade: any, i) => (
                      <div className="table-row five" key={`${trade.id ?? trade.ticket ?? i}`}>
                        <span>{trade.closedAt ? new Date(trade.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
                        <span className="symbol-name">{trade.symbol}</span>
                        <span><SignalBadge side={trade.side === 'SELL' ? 'SELL' : 'BUY'} /></span>
                        <span className={(trade.profit ?? 0) >= 0 ? 'positive' : 'negative'}>{trade.profit == null ? '—' : `${trade.profit >= 0 ? '+' : ''}${fmtMoney(Number(trade.profit))}`}</span>
                        <span className={`status-badge ${trade.status === 'open' ? 'live' : 'closed'}`}>{String(trade.status ?? '—').toUpperCase()}</span>
                      </div>
                    ))}
                    {!recentTrades.length && <div className="empty-state">No trade history yet.</div>}
                  </div>
                </Panel>

                <Panel title="Risk Management" subtitle="Centralized protective gates" className="risk-panel" right={<button className="link-button" onClick={() => setActiveTab('risk')}>View details <ChevronRight size={14} /></button>}>
                  <div className="risk-grid">
                    <div className="risk-card"><span>Drawdown</span><strong className={drawdown > 4 ? 'negative' : 'positive'}>{fmtPct(drawdown)}</strong><small>Current</small></div>
                    <div className="risk-card"><span>Open trades</span><strong>{openTrades.length}</strong><small>Live / paper</small></div>
                    <div className="risk-card"><span>Circuit breaker</span><strong className={status?.circuitBreaker?.tripped ? 'negative' : 'positive'}>{status?.circuitBreaker?.tripped ? 'TRIPPED' : 'NORMAL'}</strong><small>{status?.circuitBreaker?.consecutiveLosses ?? 0} losses</small></div>
                    <div className="risk-card"><span>Recovery</span><strong>{recovery?.level ?? 'GREEN'}</strong><small>×{Number(recovery?.volumeMultiplier ?? 1).toFixed(2)} size</small></div>
                  </div>
                  <div className="risk-footer"><StatusDot live={!status?.circuitBreaker?.tripped} /><span>{status?.circuitBreaker?.tripped ? 'Execution blocked by circuit breaker' : 'Risk gates operating normally'}</span></div>
                </Panel>
              </section>
            </>
          )}

          {activeTab === 'trading' && (
            <div className="page-grid two-col">
              <Panel title="Open Trades" subtitle={`${openTrades.length} currently open`} className="span-2">
                <div className="trade-table table-scroll wide-table">
                  <div className="table-head six"><span>Symbol</span><span>Side</span><span>Entry</span><span>SL</span><span>TP</span><span>Strategy</span></div>
                  {openTrades.map((trade: any, i) => (
                    <div className="table-row six" key={trade.id ?? trade.ticket ?? i}>
                      <span className="symbol-name">{trade.symbol}</span>
                      <span><SignalBadge side={trade.side === 'SELL' ? 'SELL' : 'BUY'} /></span>
                      <span>{fmtPrice(Number(trade.entry ?? 0))}</span>
                      <span>{fmtPrice(Number(trade.sl ?? 0))}</span>
                      <span>{fmtPrice(Number(trade.tp ?? 0))}</span>
                      <span className="muted">{trade.source ?? '—'}</span>
                    </div>
                  ))}
                  {!openTrades.length && <div className="empty-state">No open positions. The risk layer is not carrying exposure right now.</div>}
                </div>
              </Panel>
              <Panel title="Signal Feed" subtitle="Latest strategy candidates">
                <div className="feed-list">
                  {visibleSignals.map((signal, i) => (
                    <div className="feed-item" key={`${signal.timestamp}-${signal.symbol}-${i}`}>
                      <div className="feed-top"><strong>{signal.symbol}</strong><SignalBadge side={signal.side} /><span className="muted">{timeAgo(signal.timestamp)}</span></div>
                      <div className="feed-meta"><span>{signal.source ?? '—'}</span><span>Conf. {fmtPct(Number(signal.confidence ?? 0) * 100)}</span></div>
                      <p>{signal.reason ?? 'No reason recorded.'}</p>
                    </div>
                  ))}
                  {!visibleSignals.length && <div className="empty-state">No recent signals.</div>}
                </div>
              </Panel>
              <Panel title="Execution Controls" subtitle="Authorized paper-mode controls">
                <div className="control-stack">
                  <button className="control-button green" disabled={busy || running} onClick={() => doControl('start')}><PlayCircle size={18} /> Start engine</button>
                  <button className="control-button amber" disabled={busy || !running} onClick={() => doControl('stop')}><PauseCircle size={18} /> Stop engine</button>
                  <button className="control-button red" disabled={busy} onClick={() => doControl('emergency')}><AlertTriangle size={18} /> Emergency stop</button>
                </div>
                <p className="control-note">Emergency and lifecycle controls are protected by the backend operator/admin role gate.</p>
              </Panel>
            </div>
          )}

          {activeTab === 'strategies' && (
            <Panel title="Strategy Performance Matrix" subtitle="Live registry status, historical metrics and confidence contribution">
              <div className="strategy-page-grid">
                {strategyCards.map(strategy => (
                  <article className="strategy-large" key={strategy.name}>
                    <div className="strategy-head"><span className="strategy-icon"><Sparkles size={14} /></span><strong>{strategy.name}</strong><span className={`status-badge ${strategy.enabled ? 'active' : 'blocked'}`}>{strategy.enabled ? 'ACTIVE' : 'BLOCKED'}</span></div>
                    <div className="big-stat"><strong>{fmtPct(strategy.wr)}</strong><span>Win rate</span></div>
                    <div className="strategy-large-row"><span>Sharpe <b>{strategy.sharpe.toFixed(2)}</b></span><span>Trades <b>{strategy.trades}</b></span><span>Expectancy <b>{strategy.expectancy.toFixed(3)}</b></span></div>
                    <div className="meter tall"><span style={{ width: `${Math.min(100, Math.max(0, strategy.wr))}%` }} /></div>
                  </article>
                ))}
              </div>
            </Panel>
          )}

          {activeTab === 'risk' && (
            <div className="page-grid two-col">
              <Panel title="Risk Overview" subtitle="Hard risk boundaries are enforced in the trading core">
                <div className="risk-big-grid">
                  <div><small>Drawdown</small><strong>{fmtPct(drawdown)}</strong><div className="ring"><span>{recovery?.level ?? 'GREEN'}</span></div></div>
                  <div><small>Daily P/L</small><strong className={todayPnl >= 0 ? 'positive' : 'negative'}>{todayPnl >= 0 ? '+' : ''}{fmtMoney(todayPnl)}</strong><span className="muted">{today?.trades ?? 0} trades</span></div>
                  <div><small>Loss streak</small><strong>{status?.circuitBreaker?.consecutiveLosses ?? 0}</strong><span className="muted">Limit {status?.circuitBreaker?.lossLimit ?? 3}</span></div>
                  <div><small>Recovery multiplier</small><strong>×{Number(recovery?.volumeMultiplier ?? 1).toFixed(2)}</strong><span className="muted">{recovery?.message ?? 'Normal conditions'}</span></div>
                </div>
              </Panel>
              <Panel title="v9 Risk Telemetry" subtitle="D1, time filter and adaptive ATR state">
                <div className="telemetry-list">
                  <div><span>D1 cache</span><strong>{v9Status?.d1Cache ?? 0} symbols</strong></div>
                  <div><span>Adaptive ATR</span><strong>{v9Status?.adaptiveATR ? 'Loaded' : 'Idle'}</strong></div>
                  <div><span>Time score</span><strong>{v9Status?.timeScore != null ? Number(v9Status.timeScore).toFixed(2) : '—'}</strong></div>
                  <div><span>Recovery state</span><strong>{recovery?.level ?? 'GREEN'}</strong></div>
                </div>
              </Panel>
            </div>
          )}

          {activeTab === 'performance' && (
            <div className="page-grid two-col">
              <Panel title="Equity Curve" subtitle="Full captured curve" className="span-2">
                <div className="chart-wrap tall"><ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData}><CartesianGrid stroke="#15263e" vertical={false} /><XAxis dataKey="time" hide /><YAxis stroke="#516279" tick={{ fill: '#7e91aa', fontSize: 11 }} /><Tooltip contentStyle={{ background: '#081426', border: '1px solid #183255', borderRadius: 10 }} formatter={(v: any) => [fmtMoney(Number(v)), 'Equity']} /><defs><linearGradient id="eq2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#39d4ff" stopOpacity={0.3}/><stop offset="100%" stopColor="#39d4ff" stopOpacity={0}/></linearGradient></defs><Area type="monotone" dataKey="equity" stroke="#39d4ff" fill="url(#eq2)" strokeWidth={2.4} dot={false}/></AreaChart></ResponsiveContainer></div>
              </Panel>
              <Panel title="Paper Statistics" subtitle="Economic metrics, not just accuracy">
                <div className="stats-list">
                  <div><span>Total trades</span><strong>{paperStats?.trades ?? all?.total ?? 0}</strong></div>
                  <div><span>Wins / Losses</span><strong>{paperStats?.wins ?? all?.wins ?? 0} / {paperStats?.losses ?? all?.losses ?? 0}</strong></div>
                  <div><span>Profit factor</span><strong>{Number(paperStats?.profitFactor ?? perf?.profitFactor ?? 0).toFixed(2)}</strong></div>
                  <div><span>Avg win / loss</span><strong>{fmtMoney(Number(paperStats?.avgWin ?? 0))} / {fmtMoney(Number(paperStats?.avgLoss ?? 0))}</strong></div>
                </div>
              </Panel>
              <Panel title="Hourly Heatmap" subtitle={heatmap?.message ?? 'Strategy timing diagnostics'}>
                <div className="hour-grid">{Array.from({ length: 24 }, (_, hour) => { const wr = Number(heatmap?.hourlyWinRate?.[hour] ?? 0.5); return <div key={hour} className="hour-cell"><span>{hour.toString().padStart(2, '0')}</span><strong>{fmtPct(wr * 100)}</strong></div>; })}</div>
              </Panel>
            </div>
          )}

          {activeTab === 'storage' && (
            <div className="page-grid two-col">
              <Panel title="MEGA Archive / Disaster Recovery" subtitle="MEGA is an archive target — never the live trading database" className="span-2">
                <div className="storage-hero">
                  <div className="storage-icon"><Cloud size={28} /></div>
                  <div><strong>MEGA backup architecture</strong><p>{storage?.mega?.note ?? 'Windows/Research agent archives consistent SQLite snapshots to MEGA with SHA-256 verification.'}</p></div>
                  <div className={`storage-state ${storage?.mega?.enabled ? 'ready' : 'external'}`}><StatusDot live={Boolean(storage?.mega?.enabled)} />{storage?.mega?.enabled ? 'Configured' : 'External agent'}</div>
                </div>
                <div className="storage-grid">
                  <div><span>Mode</span><strong>{storage?.mega?.mode ?? 'external-windows-agent'}</strong></div>
                  <div><span>Remote folder</span><strong>{storage?.mega?.folder ?? '/TradingAI/backups'}</strong></div>
                  <div><span>Credentials</span><strong>{storage?.mega?.credentialsPresent ? 'Present in runtime' : 'Kept outside Railway'}</strong></div>
                  <div><span>Policy</span><strong>SHA-256 + retention + restore checks</strong></div>
                </div>
                <div className="storage-note"><Shield size={16} /><span>For this project, the safe architecture is to keep MEGA credentials on the dedicated Windows backup agent rather than embedding them in Railway. The dashboard only exposes non-secret status.</span></div>
              </Panel>
              <Panel title="Recent Journal" subtitle="Operational lessons and trade notes">
                <div className="feed-list compact">{journal.slice(0, 8).map((entry: any, i) => <div className="feed-item" key={i}><div className="feed-top"><strong>{entry.symbol} {entry.side}</strong><span className="badge neutral">{entry.grade ?? '—'}</span></div><p>{entry.lesson ?? 'No lesson recorded.'}</p></div>)}{!journal.length && <div className="empty-state">No journal entries yet.</div>}</div>
              </Panel>
              <Panel title="Grade Distribution" subtitle="Journal quality distribution"><div className="grade-grid">{Object.entries(grades).map(([grade, count]) => <div key={grade}><strong>{count}</strong><span>Grade {grade}</span></div>)}</div></Panel>
            </div>
          )}

          {activeTab === 'ml' && (
            <div className="page-grid two-col">
              <Panel title="ML / AI Status" subtitle="Advisory layer — it cannot bypass risk gates" className="span-2">
                <div className="ml-hero"><div className={`ml-orb ${mlStatus?.trained ? 'ready' : 'idle'}`}><Brain size={26}/></div><div><strong>{mlStatus?.trained ? 'Model ready' : 'Training required'}</strong><p>Model output remains subordinate to consensus, R:R and risk controls.</p></div><button className="control-button blue" onClick={async () => { setBusy(true); try { await API.mlTrain(); await refresh(); } catch (e: any) { setError(e?.response?.data?.error ?? e?.message ?? 'ML training failed'); } finally { setBusy(false); } }} disabled={busy}>Retrain</button></div>
              </Panel>
              <Panel title="Feature Importance" subtitle="Current model ranking">
                <div className="feature-list">{Object.entries(mlStatus?.importance ?? {}).sort(([,a]: any,[,b]: any) => Number(b) - Number(a)).slice(0, 12).map(([name, value]: any) => <div key={name}><span>{name}</span><div className="meter"><span style={{ width: `${Math.min(100, Number(value) * 1000)}%` }}/></div><b>{(Number(value) * 100).toFixed(1)}%</b></div>)}</div>
              </Panel>
              <Panel title="Live Signal Context" subtitle="Newest candidate seen by the UI"><div className="signal-context">{liveSignal ? <><div className="signal-big"><SignalBadge side={liveSignal.side}/><strong>{liveSignal.symbol}</strong><span>{fmtPrice(liveSignal.price)}</span></div><div className="signal-context-row"><span>Confidence</span><b>{fmtPct(Number(liveSignal.confidence ?? 0) * 100)}</b></div><div className="signal-context-row"><span>Source</span><b>{liveSignal.source ?? '—'}</b></div><div className="signal-context-row"><span>Reason</span><b>{liveSignal.reason ?? '—'}</b></div></> : <div className="empty-state">Waiting for a live signal.</div>}</div></Panel>
            </div>
          )}

          {activeTab === 'symbols' && (
            <Panel title="Symbol Universe" subtitle="Current validated market rotation and discovery scores">
              <div className="symbol-score-grid">{symbolScores.map((score: any) => <article key={score.symbol} className="symbol-score-card"><div className="symbol-head"><strong>{score.symbol}</strong><span className={`status-badge ${score.suitable ? 'active' : 'blocked'}`}>{score.suitable ? 'SUITABLE' : 'FILTERED'}</span></div><div className="score-value"><strong>{Number(score.score ?? 0)}</strong><span>/100</span></div><div className="meter tall"><span style={{ width: `${Math.min(100, Math.max(0, Number(score.score ?? 0)))}%` }}/></div><p>{score.reason ?? 'No score reason available.'}</p></article>)}{!symbolScores.length && symbols.map(symbol => <article key={symbol} className="symbol-score-card"><div className="symbol-head"><strong>{symbol}</strong><span className="status-badge active">VALIDATED</span></div><div className="score-value"><strong>—</strong></div><p>Validated by the trading engine. Discovery score not yet available.</p></article>)}</div>
            </Panel>
          )}

          {activeTab === 'logs' && (
            <div className="page-grid two-col">
              <Panel title="Signal Log" subtitle="Most recent engine candidates"><div className="log-list">{signals.slice(0, 30).map((signal, i) => <div className="log-line" key={`${signal.timestamp}-${i}`}><span className="log-time">{signal.timestamp ? new Date(signal.timestamp).toLocaleTimeString() : '—'}</span><span className={`log-badge ${signal.side === 'BUY' ? 'buy' : 'sell'}`}>{signal.side}</span><span className="log-msg">{signal.symbol} • {signal.source ?? 'strategy'} • conf {fmtPct(Number(signal.confidence ?? 0) * 100)}</span></div>)}{!signals.length && <div className="empty-state">No signals recorded.</div>}</div></Panel>
              <Panel title="Consensus State" subtitle="Current voting architecture"><div className="stats-list"><div><span>Active strategies</span><strong>{activeStrategies}/{totalStrategies || 0}</strong></div><div><span>Last consensus</span><strong>{consensus?.last_log_entry?.reason ?? consensus?.last_log_entry?.side ?? '—'}</strong></div><div><span>Last signal</span><strong>{liveSignal ? `${liveSignal.symbol} ${liveSignal.side}` : '—'}</strong></div><div><span>Engine</span><strong>{running ? 'RUNNING' : 'STOPPED'}</strong></div></div></Panel>
            </div>
          )}
        </main>

        <footer className="footer-bar">
          <div><StatusDot live={running} /> <span>{running ? 'Trading engine online' : 'Trading engine offline'}</span></div>
          <span>Paper mode • API v9.2 • UI v10</span>
        </footer>
      </div>
    </div>
  );
}
