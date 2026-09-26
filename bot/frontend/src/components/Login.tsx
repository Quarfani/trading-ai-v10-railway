import { useState } from 'react';
import { api } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post('/api/auth/login', { password: pwd });
      localStorage.setItem('token', r.data.token);
      onSuccess();
    } catch { setErr('كلمة سر غير صحيحة'); }
  };
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <form onSubmit={submit} className="bg-slate-900 p-8 rounded-lg w-80 border border-slate-800">
        <h1 className="text-xl font-bold text-slate-100 mb-4 text-center">🤖 تسجيل الدخول</h1>
        <input type="password" value={pwd} onChange={e=>setPwd(e.target.value)}
          placeholder="كلمة السر" className="w-full px-3 py-2 bg-slate-800 rounded mb-3 text-slate-100"/>
        {err && <div className="text-rose-400 text-sm mb-2">{err}</div>}
        <button className="w-full py-2 bg-emerald-600 rounded text-white">دخول</button>
      </form>
    </div>
  );
}
