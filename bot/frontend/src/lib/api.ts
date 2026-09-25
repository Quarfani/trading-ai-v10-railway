import axios from 'axios';
import { io } from 'socket.io-client';
const BASE = String((import.meta as any).env?.VITE_API_URL ?? '').replace(/\/$/, '');
const api  = axios.create({ baseURL: BASE || undefined });
export const socket = io(BASE, { autoConnect: false });
api.interceptors.request.use(cfg => {
  const t = localStorage.getItem('token');
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});
export const API = {
  status:      () => api.get('/api/status'),
  consensus:   () => api.get('/api/consensus'),
  positions:   () => api.get('/api/positions'),
  trades:  (n=50) => api.get(`/api/trades?limit=${n}`),
  equity:      () => api.get('/api/equity'),
  recovery:    () => api.get('/api/recovery'),
  correlation: () => api.get('/api/correlation'),
  sentiment: (s: string) => api.get(`/api/sentiment/${s}`),
  journal: (n=50) => api.get(`/api/journal?limit=${n}`),
  journalGrades: () => api.get('/api/journal/grades'),
  mlStatus: () => api.get('/api/ml/status'),
  mlTrain: () => api.post('/api/ml/train'),
  montecarlo: () => api.post('/api/montecarlo', { simulations: 5000, trades: 100 }),
  symbolScores: () => api.get('/api/symbols/scores'),
  emergency: () => api.post('/api/control/emergency', { reason: 'Dashboard' }),
  start:     () => api.post('/api/control/start'),
  stop:      () => api.post('/api/control/stop'),
};
