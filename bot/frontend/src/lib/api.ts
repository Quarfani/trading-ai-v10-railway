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
      window.dispatchEvent(new Event('trading-auth-expired'));
    }
    return Promise.reject(error);
  },
);

export const API = {
  health: () => api.get('/api/health'),
  status: () => api.get('/api/status'),
  paperStats: () => api.get('/api/paper/stats'),
  consensus: () => api.get('/api/consensus'),
  consensusLog: (n = 50) => api.get(`/api/consensus/log?n=${n}`),
  positions: () => api.get('/api/positions'),
  trades: (n = 50) => api.get(`/api/trades?limit=${n}`),
  openTrades: () => api.get('/api/trades/open'),
  equity: () => api.get('/api/equity'),
  signals: (n = 50) => api.get(`/api/signals?limit=${n}`),
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
