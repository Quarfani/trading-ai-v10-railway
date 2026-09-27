import axios from 'axios';
import { io } from 'socket.io-client';

const BASE = String((import.meta as any).env?.VITE_API_URL ?? '').replace(/\/$/, '');
const api = axios.create({ baseURL: BASE || undefined, timeout: 12_000 });

export const socket = io(BASE || undefined, { autoConnect: false, transports: ['websocket', 'polling'] });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(
  response => response,
  error => {
    if (error?.response?.status === 401) {
      localStorage.removeItem('token');
    }
    return Promise.reject(error);
  },
);

export const API = {
  health: () => api.get('/api/health'),
  status: () => api.get('/api/status'),
  consensus: () => api.get('/api/consensus'),
  consensusLog: (n = 50) => api.get(`/api/consensus/log?n=${n}`),
  positions: () => api.get('/api/positions'),
  trades: (n = 50) => api.get(`/api/trades?limit=${n}`),
  openTrades: () => api.get('/api/trades/open'),
  equity: () => api.get('/api/equity'),
  signals: (n = 50) => api.get(`/api/signals?limit=${n}`),
  paperStats: async () => {
    const [statusRes, tradesRes] = await Promise.all([
      api.get('/api/status'),
      api.get('/api/trades?limit=500'),
    ]);

    const performance = statusRes.data?.performance ?? {};
    const rows = Array.isArray(tradesRes.data?.trades)
      ? tradesRes.data.trades
      : [];

    const closed = rows.filter((t: any) =>
      String(t?.status ?? '').toLowerCase() === 'closed' ||
      t?.closedAt != null
    );

    const profits = closed.map((t: any) => Number(t?.profit ?? 0))
      .filter((v: number) => Number.isFinite(v));

    const wins = profits.filter((v: number) => v > 0);
    const losses = profits.filter((v: number) => v <= 0);

    const grossWin = wins.reduce((s: number, v: number) => s + v, 0);
    const grossLoss = Math.abs(
      losses.reduce((s: number, v: number) => s + v, 0)
    );

    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;

    const totalPnl = profits.reduce((s: number, v: number) => s + v, 0);

    const stats = {
      trades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      profitFactor:
        grossLoss > 0
          ? grossWin / grossLoss
          : grossWin > 0
            ? Infinity
            : 0,
      avgWin,
      avgLoss,
      riskReward: avgLoss > 0 ? avgWin / avgLoss : 0,
      totalPnl,
      roi: 0,
      maxDrawdownPct: 0,
      balance:
        Number.isFinite(Number(performance?.equity))
          ? Number(performance.equity)
          : undefined,
      equityCurve: [],
    };

    return {
      ...statusRes,
      data: stats,
    };
  },
  recovery: () => api.get('/api/recovery'),
  journal: (n = 50) => api.get(`/api/journal?limit=${n}`),
  journalGrades: () => api.get('/api/journal/grades'),
  mlStatus: () => api.get('/api/ml/status'),
  mlTrain: () => api.post('/api/ml/train'),
  montecarlo: () => api.post('/api/montecarlo', { simulations: 5000, trades: 100 }),
  symbolScores: () => api.get('/api/symbols/scores'),
  symbols: () => api.get('/api/symbols'),
  regime: (symbol: string, tf = 'H1') => api.get(`/api/regime/${encodeURIComponent(symbol)}?tf=${tf}`),
  heatmap: () => api.get('/api/heatmap'),
  v9Status: () => api.get('/api/v9/status'),
  storageStatus: () => api.get('/api/storage/status'),
  correlation: () => api.get('/api/correlation'),
  sentiment: (symbol: string) => api.get(`/api/sentiment/${encodeURIComponent(symbol)}`),
  emergency: () => api.post('/api/control/emergency', { reason: 'Dashboard emergency stop' }),
  start: () => api.post('/api/control/start'),
  stop: () => api.post('/api/control/stop'),
};
