import { useEffect, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts';
import {
  TrendingUp,
  Activity,
  Shield,
  Brain,
  CheckCircle,
  XCircle,
  RefreshCw,
  Zap,
  LogIn,
  LockKeyhole,
  AlertTriangle,
} from 'lucide-react';

import { API, socket } from './lib/api';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Status {
  running: boolean;
  mode: string;
  circuitBreaker: string;
  performance: any;
  openPositions: any;
}

interface RecoveryState {
  level: string;
  drawdownPct: number;
  volumeMultiplier: number;
  message: string;
}

interface LoginResponse {
  token?: string;
  accessToken?: string;
  sessionToken?: string;
  jwt?: string;
  data?: {
    token?: string;
    accessToken?: string;
    sessionToken?: string;
    jwt?: string;
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  GREEN: '#22c55e',
  YELLOW: '#eab308',
  ORANGE: '#f97316',
  RED: '#ef4444',
  STOP: '#7f1d1d',
};

// ── Authentication helpers ────────────────────────────────────────────────────

function saveAuthToken(payload: LoginResponse): string | null {
  const token =
    payload.token ??
    payload.accessToken ??
    payload.sessionToken ??
    payload.jwt ??
    payload.data?.token ??
    payload.data?.accessToken ??
    payload.data?.sessionToken ??
    payload.data?.jwt ??
    null;

  if (!token) return null;

  // Save under several conventional names so the existing API client
  // can use whichever token key it expects.
  localStorage.setItem('token', token);
  localStorage.setItem('authToken', token);
  localStorage.setItem('accessToken', token);
  localStorage.setItem('sessionToken', token);

  return token;
}

function hasLocalAuth(): boolean {
  return Boolean(
    localStorage.getItem('token') ||
    localStorage.getItem('authToken') ||
    localStorage.getItem('accessToken') ||
    localStorage.getItem('sessionToken')
  );
}

function clearLocalAuth(): void {
  localStorage.removeItem('token');
  localStorage.removeItem('authToken');
  localStorage.removeItem('accessToken');
  localStorage.removeItem('sessionToken');
}

// ── Login screen ──────────────────────────────────────────────────────────────

function DashboardLogin({
  onSuccess,
}: {
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!password.trim()) {
      setError('Please enter the dashboard password.');
      return;
    }

    setBusy(true);
    setError('');

    try {
      const baseUrl =
        (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password,
        }),
      });

      let payload: LoginResponse = {};

      try {
        payload = await response.json();
      } catch {
        payload = {};
      }

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Invalid dashboard password.');
        }

        throw new Error(
          payload?.data?.token
            ? 'Authentication failed.'
            : `Login failed (${response.status}).`
        );
      }

      saveAuthToken(payload);

      // The backend may authenticate with an HttpOnly cookie instead
      // of a JSON token. In that case credentials: include above
      // preserves the session automatically.
      setPassword('');
      onSuccess();
    } catch (err: any) {
      setError(
        err?.message ||
          'Unable to connect to the authentication service.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-8">
          <div className="flex justify-center mb-6">
            <div className="w-16 h-16 rounded-2xl bg-blue-900/40 border border-blue-700/40 flex items-center justify-center">
              <LockKeyhole size={30} className="text-blue-400" />
            </div>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-white">
              Trading AI Dashboard
            </h1>

            <p className="text-gray-400 text-sm mt-2">
              Secure Dashboard Authentication
            </p>
          </div>

          <form onSubmit={submit} className="space-y-5">
            <div>
              <label
                htmlFor="dashboard-password"
                className="block text-sm text-gray-400 mb-2"
              >
                Dashboard Password
              </label>

              <input
                id="dashboard-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter dashboard password"
                className="w-full rounded-xl bg-gray-950 border border-gray-700 px-4 py-3 text-white outline-none focus:border-blue-500"
                disabled={busy}
              />
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
                <AlertTriangle size={17} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:cursor-not-allowed px-4 py-3 font-semibold text-white transition-colors"
            >
              {busy ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  Signing in...
                </>
              ) : (
                <>
                  <LogIn size={18} />
                  Sign In
                </>
              )}
            </button>
          </form>

          <div className="mt-6 text-center text-xs text-gray-500">
            Authentication is handled by the secure backend session.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean>(
    () => hasLocalAuth()
  );

  const [status, setStatus] = useState<Status | null>(null);
  const [consensus, setConsensus] = useState<any>(null);
  const [equity, setEquity] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [journal, setJournal] = useState<any[]>([]);
  const [grades, setGrades] = useState<any>({});
  const [mlStatus, setMlStatus] = useState<any>(null);
  const [symScores, setSymScores] = useState<any[]>([]);

  const [loading, setLoading] = useState(true);
  const [authChecking, setAuthChecking] = useState(true);
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [liveSignal, setLiveSignal] = useState<any>(null);

  const forceLogout = () => {
    clearLocalAuth();
    setAuthenticated(false);
    setStatus(null);
    setConsensus(null);
    setEquity([]);
    setTrades([]);
    setRecovery(null);
    setJournal([]);
    setGrades({});
    setMlStatus(null);
    setSymScores([]);
  };

  const refresh = async () => {
    if (!authenticated) return;

    try {
      const results = await Promise.allSettled([
        API.status(),
        API.consensus(),
        API.equity(),
        API.trades(30),
        API.recovery(),
        API.journal(20),
        API.journalGrades(),
        API.mlStatus(),
        API.symbolScores(),
      ]);

      const unauthorized = results.some(
        (result: any) =>
          result.status === 'rejected' &&
          (result.reason?.response?.status === 401 ||
            result.reason?.status === 401)
      );

      if (unauthorized) {
        forceLogout();
        return;
      }

      const [s, c, e, t, r, j, g, ml, ss] = results;

      if (s.status === 'fulfilled') {
        setStatus(s.value.data);
      }

      if (c.status === 'fulfilled') {
        setConsensus(c.value.data);
      }

      if (e.status === 'fulfilled') {
        setEquity(
          (e.value.data?.curve ?? []).slice(-100)
        );
      }

      if (t.status === 'fulfilled') {
        setTrades(
          t.value.data?.trades ?? []
        );
      }

      if (r.status === 'fulfilled') {
        setRecovery(r.value.data);
      }

      if (j.status === 'fulfilled') {
        setJournal(
          j.value.data?.entries ?? []
        );
      }

      if (g.status === 'fulfilled') {
        setGrades(g.value.data ?? {});
      }

      if (ml.status === 'fulfilled') {
        setMlStatus(ml.value.data);
      }

      if (ss.status === 'fulfilled') {
        setSymScores(
          ss.value.data?.scores ?? []
        );
      }
    } catch {
      // Individual API failures are intentionally tolerated so
      // one unavailable subsystem does not crash the dashboard.
    }

    setLoading(false);
  };

  useEffect(() => {
    if (!authenticated) {
      setAuthChecking(false);
      setLoading(false);
      return;
    }

    setAuthChecking(false);
    setLoading(true);

    let alive = true;

    const runInitialRefresh = async () => {
      if (!alive) return;
      await refresh();
    };

    runInitialRefresh();

    const interval = window.setInterval(() => {
      if (alive) refresh();
    }, 30_000);

    const onSignal = (sig: any) => {
      if (alive) {
        setLiveSignal(sig);
      }
    };

    socket.on('signal', onSignal);
    socket.connect();

    return () => {
      alive = false;
      window.clearInterval(interval);
      socket.off('signal', onSignal);
      socket.disconnect();
    };
  }, [authenticated]);

  // ── Login gate ─────────────────────────────────────────────────────────────

  if (authChecking) {
    return (
      <div className="flex h-screen bg-gray-950 items-center justify-center">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">
            Checking authentication...
          </p>
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <DashboardLogin
        onSuccess={() => {
          setAuthenticated(true);
          setLoading(true);
        }}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen bg-gray-950 items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">
            Loading Trading Dashboard...
          </p>
        </div>
      </div>
    );
  }

  // ── Derived values ─────────────────────────────────────────────────────────

  const perf = status?.performance;
  const today = perf?.today ?? {};
  const winRate =
    ((perf?.winrate ?? 0) * 100).toFixed(1);

  const equityValue =
    typeof perf?.equity === 'number'
      ? perf.equity
      : 0;

  const equity$ =
    equityValue.toFixed(2);

  const stratCount =
    consensus?.active_count ?? 0;

  const tabs = [
    'overview',
    'strategies',
    'trades',
    'recovery',
    'journal',
    'ml',
    'symbols',
  ];

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">

      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-3 h-3 rounded-full ${
                status?.running
                  ? 'bg-green-400 animate-pulse'
                  : 'bg-red-500'
              }`}
            />

            <h1 className="text-xl font-bold text-white">
              Trading Bot v8.0
            </h1>

            <span className="px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded text-xs font-mono">
              {status?.mode?.toUpperCase() ?? 'PAPER'}
            </span>

            {liveSignal && (
              <span
                className={`px-2 py-0.5 rounded text-xs font-mono animate-pulse ${
                  liveSignal.side === 'BUY'
                    ? 'bg-green-900 text-green-300'
                    : 'bg-red-900 text-red-300'
                }`}
              >
                🔔 {liveSignal.symbol} {liveSignal.side}
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={refresh}
              className="p-2 rounded hover:bg-gray-800 text-gray-400 hover:text-white"
              title="Refresh"
            >
              <RefreshCw size={16} />
            </button>

            <button
              onClick={() => API.emergency()}
              className="px-3 py-1.5 bg-red-900/50 hover:bg-red-800 border border-red-700 text-red-300 rounded text-sm"
            >
              🛑 Emergency Stop
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-4 flex gap-1 pb-0 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── OVERVIEW ───────────────────────────────────────────────────── */}

        {activeTab === 'overview' && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                {
                  label: 'Equity',
                  value: `$${equity$}`,
                  icon: <TrendingUp size={20} />,
                  color: 'text-green-400',
                },
                {
                  label: 'Win Rate',
                  value: `${winRate}%`,
                  icon: <Activity size={20} />,
                  color:
                    Number(winRate) >= 52
                      ? 'text-green-400'
                      : 'text-yellow-400',
                },
                {
                  label: 'Today P/L',
                  value: `$${(today.pnl ?? 0).toFixed(2)}`,
                  icon: <Zap size={20} />,
                  color:
                    (today.pnl ?? 0) >= 0
                      ? 'text-green-400'
                      : 'text-red-400',
                },
                {
                  label: 'Strategies',
                  value: `${stratCount}/8`,
                  icon: <Brain size={20} />,
                  color: 'text-blue-400',
                },
              ].map((card) => (
                <div
                  key={card.label}
                  className="bg-gray-900 border border-gray-800 rounded-xl p-4"
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-gray-400 text-sm">
                      {card.label}
                    </span>
                    <span className={card.color}>
                      {card.icon}
                    </span>
                  </div>

                  <p
                    className={`text-2xl font-bold ${card.color}`}
                  >
                    {card.value}
                  </p>
                </div>
              ))}
            </div>

            {/* Equity Curve */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">
                Equity Curve
              </h2>

              <ResponsiveContainer width="100%" height={200}>
                <AreaChart data={equity}>
                  <defs>
                    <linearGradient
                      id="eq"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop
                        offset="5%"
                        stopColor="#3b82f6"
                        stopOpacity={0.3}
                      />
                      <stop
                        offset="95%"
                        stopColor="#3b82f6"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>

                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1f2937"
                  />

                  <XAxis
                    dataKey="t"
                    tickFormatter={(value) =>
                      new Date(value).toLocaleDateString()
                    }
                    stroke="#4b5563"
                    tick={{ fontSize: 11 }}
                  />

                  <YAxis
                    stroke="#4b5563"
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) =>
                      `$${Number(value).toFixed(0)}`
                    }
                  />

                  <Tooltip
                    formatter={(value: any) => [
                      `$${Number(value ?? 0).toFixed(2)}`,
                      'Equity',
                    ]}
                    contentStyle={{
                      background: '#111827',
                      border: '1px solid #374151',
                      borderRadius: 8,
                    }}
                  />

                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="#3b82f6"
                    fill="url(#eq)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* Recovery */}
            {recovery && (
              <div
                className="bg-gray-900 border rounded-xl p-4"
                style={{
                  borderColor:
                    (LEVEL_COLORS[recovery.level] ??
                      '#6b7280') + '44',
                }}
              >
                <div className="flex items-center gap-3">
                  <Shield
                    size={20}
                    style={{
                      color:
                        LEVEL_COLORS[recovery.level] ??
                        '#6b7280',
                    }}
                  />

                  <div>
                    <span
                      className="font-semibold"
                      style={{
                        color:
                          LEVEL_COLORS[recovery.level] ??
                          '#6b7280',
                      }}
                    >
                      Recovery Mode: {recovery.level}
                    </span>

                    <p className="text-gray-400 text-sm">
                      {recovery.message}
                    </p>
                  </div>

                  <span className="ml-auto text-gray-300 font-mono">
                    DD:{' '}
                    {(recovery.drawdownPct * 100).toFixed(2)}%
                    {' | '}
                    Vol: ×{recovery.volumeMultiplier}
                  </span>
                </div>
              </div>
            )}

            {/* Open Positions */}
            {status?.openPositions &&
              Object.keys(status.openPositions).length > 0 && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
                  <h2 className="text-lg font-semibold mb-4">
                    Open Positions
                  </h2>

                  <div className="space-y-2">
                    {Object.entries(status.openPositions).map(
                      ([symbol, position]: [string, any]) => (
                        <div
                          key={symbol}
                          className="flex items-center justify-between bg-gray-800 rounded-lg px-4 py-2"
                        >
                          <span className="font-mono font-semibold">
                            {symbol}
                          </span>

                          <span
                            className={`px-2 py-0.5 rounded text-xs font-mono ${
                              position.side === 'BUY'
                                ? 'bg-green-900/50 text-green-300'
                                : 'bg-red-900/50 text-red-300'
                            }`}
                          >
                            {position.side}
                          </span>

                          <span className="text-gray-400 text-sm">
                            {position.source}
                          </span>

                          <span className="text-gray-500 text-xs">
                            {position.openedAt
                              ? new Date(
                                  position.openedAt
                                ).toLocaleTimeString()
                              : '—'}
                          </span>
                        </div>
                      )
                    )}
                  </div>
                </div>
              )}
          </>
        )}

        {/* ── STRATEGIES ───────────────────────────────────────────────── */}

        {activeTab === 'strategies' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">
              Strategy Performance
            </h2>

            <div className="space-y-3">
              {Object.entries(
                consensus?.strategies ?? {}
              ).map(
                ([name, strategy]: [string, any]) => {
                  const winRateValue =
                    (strategy.metrics?.win_rate ?? 0.5) * 100;

                  const sharpe =
                    strategy.metrics?.sharpe_ratio ?? 0;

                  return (
                    <div
                      key={name}
                      className="bg-gray-800 rounded-lg p-4"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          {strategy.enabled ? (
                            <CheckCircle
                              size={16}
                              className="text-green-400"
                            />
                          ) : (
                            <XCircle
                              size={16}
                              className="text-red-400"
                            />
                          )}

                          <span className="font-mono font-semibold">
                            {name}
                          </span>
                        </div>

                        <div className="flex gap-4 text-sm">
                          <span
                            className={
                              winRateValue >= 52
                                ? 'text-green-400'
                                : 'text-yellow-400'
                            }
                          >
                            WR: {winRateValue.toFixed(1)}%
                          </span>

                          <span
                            className={
                              sharpe >= 0.8
                                ? 'text-green-400'
                                : 'text-gray-400'
                            }
                          >
                            Sharpe: {sharpe.toFixed(2)}
                          </span>

                          <span className="text-gray-400">
                            Trades:{' '}
                            {strategy.metrics?.total_trades ?? 0}
                          </span>
                        </div>
                      </div>

                      <div className="h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500 transition-all"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.max(0, winRateValue)
                            )}%`,
                          }}
                        />
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          </div>
        )}

        {/* ── TRADES ───────────────────────────────────────────────────── */}

        {activeTab === 'trades' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">
              Recent Trades
            </h2>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left py-2 px-3">
                      Symbol
                    </th>
                    <th className="text-left py-2 px-3">
                      Side
                    </th>
                    <th className="text-right py-2 px-3">
                      Entry
                    </th>
                    <th className="text-right py-2 px-3">
                      P/L
                    </th>
                    <th className="text-left py-2 px-3">
                      Source
                    </th>
                    <th className="text-left py-2 px-3">
                      Status
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {trades.map(
                    (trade: any, index: number) => (
                      <tr
                        key={index}
                        className="border-b border-gray-800/50 hover:bg-gray-800/30"
                      >
                        <td className="py-2 px-3 font-mono font-semibold">
                          {trade.symbol}
                        </td>

                        <td className="py-2 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs ${
                              trade.side === 'BUY'
                                ? 'bg-green-900/40 text-green-300'
                                : 'bg-red-900/40 text-red-300'
                            }`}
                          >
                            {trade.side}
                          </span>
                        </td>

                        <td className="py-2 px-3 text-right font-mono">
                          {typeof trade.entry === 'number'
                            ? trade.entry.toFixed(5)
                            : '—'}
                        </td>

                        <td
                          className={`py-2 px-3 text-right font-mono font-semibold ${
                            (trade.profit ?? 0) >= 0
                              ? 'text-green-400'
                              : 'text-red-400'
                          }`}
                        >
                          {trade.profit != null
                            ? `${
                                trade.profit >= 0 ? '+' : ''
                              }$${trade.profit.toFixed(2)}`
                            : '—'}
                        </td>

                        <td className="py-2 px-3 text-gray-400 text-xs">
                          {trade.source
                            ?.split('+')
                            ?.[
                              0
                            ] ?? '—'}
                        </td>

                        <td className="py-2 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-xs ${
                              trade.status === 'open'
                                ? 'bg-blue-900/40 text-blue-300'
                                : 'bg-gray-800 text-gray-400'
                            }`}
                          >
                            {trade.status ?? '—'}
                          </span>
                        </td>
                      </tr>
                    )
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── RECOVERY ────────────────────────────────────────────────── */}

        {activeTab === 'recovery' && recovery && (
          <div className="space-y-6">
            <div
              className="bg-gray-900 border rounded-xl p-6"
              style={{
                borderColor:
                  (LEVEL_COLORS[recovery.level] ??
                    '#6b7280') + '66',
              }}
            >
              <h2
                className="text-2xl font-bold mb-2"
                style={{
                  color:
                    LEVEL_COLORS[recovery.level] ??
                    '#6b7280',
                }}
              >
                {recovery.level} MODE
              </h2>

              <p className="text-gray-300 mb-4">
                {recovery.message}
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-800 rounded-lg p-3">
                  <p className="text-gray-500 text-sm">
                    Drawdown
                  </p>
                  <p className="text-xl font-bold">
                    {(recovery.drawdownPct * 100).toFixed(2)}%
                  </p>
                </div>

                <div className="bg-gray-800 rounded-lg p-3">
                  <p className="text-gray-500 text-sm">
                    Vol Multiplier
                  </p>
                  <p className="text-xl font-bold">
                    ×{recovery.volumeMultiplier}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── JOURNAL ────────────────────────────────────────────────── */}

        {activeTab === 'journal' && (
          <div className="space-y-6">
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">
                Grade Distribution
              </h2>

              <div className="flex gap-4">
                {Object.entries(grades).map(
                  ([grade, count]: [string, any]) => (
                    <div
                      key={grade}
                      className="flex-1 text-center bg-gray-800 rounded-lg p-3"
                    >
                      <p className="text-2xl font-bold">
                        {count}
                      </p>

                      <p className="text-gray-400 text-sm">
                        Grade {grade}
                      </p>
                    </div>
                  )
                )}
              </div>
            </div>

            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
              <h2 className="text-lg font-semibold mb-4">
                Recent Journal Entries
              </h2>

              <div className="space-y-3">
                {journal.map(
                  (entry: any, index: number) => (
                    <div
                      key={index}
                      className="bg-gray-800 rounded-lg p-4"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono font-semibold">
                          {entry.symbol} {entry.side} #
                          {entry.tradeId}
                        </span>

                        <div className="flex gap-2">
                          <span className="font-bold text-lg">
                            {entry.grade}
                          </span>

                          <span
                            className={`font-semibold ${
                              (entry.profit ?? 0) >= 0
                                ? 'text-green-400'
                                : 'text-red-400'
                            }`}
                          >
                            ${(entry.profit ?? 0).toFixed(2)}
                          </span>
                        </div>
                      </div>

                      <p className="text-gray-400 text-sm">
                        {entry.lesson}
                      </p>

                      {entry.patternMatch && (
                        <p className="text-blue-400 text-xs mt-1">
                          {entry.patternMatch}
                        </p>
                      )}
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── ML ─────────────────────────────────────────────────────── */}

        {activeTab === 'ml' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold">
                ML Model Status
              </h2>

              <button
                onClick={() => API.mlTrain()}
                className="px-4 py-2 bg-blue-900/50 hover:bg-blue-800 border border-blue-700 rounded-lg text-sm text-blue-300"
              >
                🔄 Retrain Model
              </button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className="bg-gray-800 rounded-lg p-4">
                <p className="text-gray-500 text-sm">
                  Status
                </p>

                <p
                  className={`text-xl font-bold ${
                    mlStatus?.trained
                      ? 'text-green-400'
                      : 'text-yellow-400'
                  }`}
                >
                  {mlStatus?.trained
                    ? '✅ Trained'
                    : '⏳ Not trained'}
                </p>
              </div>
            </div>

            {mlStatus?.importance && (
              <div>
                <h3 className="text-sm font-semibold text-gray-400 mb-3">
                  Feature Importance
                </h3>

                <div className="space-y-2">
                  {Object.entries(
                    mlStatus.importance
                  )
                    .sort(
                      ([, a]: any, [, b]: any) =>
                        b - a
                    )
                    .slice(0, 8)
                    .map(
                      ([feature, importance]: any) => (
                        <div
                          key={feature}
                          className="flex items-center gap-3"
                        >
                          <span className="text-gray-400 text-xs w-32 truncate">
                            {feature}
                          </span>

                          <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 rounded-full"
                              style={{
                                width: `${Math.min(
                                  100,
                                  (importance / 0.1) *
                                    100
                                )}%`,
                              }}
                            />
                          </div>

                          <span className="text-gray-500 text-xs w-12 text-right">
                            {(
                              importance * 100
                            ).toFixed(1)}
                            %
                          </span>
                        </div>
                      )
                    )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── SYMBOLS ────────────────────────────────────────────────── */}

        {activeTab === 'symbols' && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-6">
            <h2 className="text-lg font-semibold mb-4">
              Symbol Scores
            </h2>

            <div className="space-y-2">
              {symScores
                .filter(Boolean)
                .map((score: any) => (
                  <div
                    key={score.symbol}
                    className="flex items-center gap-4 bg-gray-800 rounded-lg px-4 py-2"
                  >
                    <span
                      className={`w-3 h-3 rounded-full ${
                        score.suitable
                          ? 'bg-green-400'
                          : 'bg-gray-600'
                      }`}
                    />

                    <span className="font-mono font-semibold w-20">
                      {score.symbol}
                    </span>

                    <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          score.suitable
                            ? 'bg-green-500'
                            : 'bg-gray-500'
                        }`}
                        style={{
                          width: `${Math.max(
                            0,
                            Math.min(
                              100,
                              Number(score.score) || 0
                            )
                          )}%`,
                        }}
                      />
                    </div>

                    <span className="text-gray-300 w-8 text-right font-mono">
                      {score.score}
                    </span>

                    <span className="text-gray-500 text-xs w-64 truncate">
                      {score.reason}
                    </span>
                  </div>
                ))}

              {!symScores.length && (
                <p className="text-gray-500 text-center py-8">
                  Run auto-discovery to see symbol scores
                </p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}