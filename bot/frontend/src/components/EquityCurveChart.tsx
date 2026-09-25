import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export function EquityCurveChart({ data }: { data: { t: number; equity: number }[] }) {
  const formatted = data.map(d => ({ ...d, label: new Date(d.t).toLocaleDateString() }));
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={formatted}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="label" stroke="#64748b" fontSize={11}/>
          <YAxis stroke="#64748b" fontSize={11} domain={['auto','auto']}/>
          <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155' }}/>
          <Line type="monotone" dataKey="equity" stroke="#10b981" dot={false} strokeWidth={2}/>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
