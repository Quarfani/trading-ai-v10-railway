import axios from 'axios';

const BASE = String((import.meta as any).env?.VITE_API_URL ?? '').replace(/\/$/, '');

// When the dashboard is served locally while the Trading Core runs on Railway,
// VITE_API_URL must point at the Railway backend. In a same-origin deployment,
// leaving it empty keeps the original /api behavior.
export const api = axios.create({ baseURL: BASE || undefined });

api.interceptors.request.use(c => {
  const t = localStorage.getItem('token');
  if (t) c.headers.Authorization = `Bearer ${t}`;
  return c;
});

api.interceptors.response.use(r => r, e => {
  if (e.response?.status === 401) {
    localStorage.removeItem('token');
    location.reload();
  }
  return Promise.reject(e);
});
