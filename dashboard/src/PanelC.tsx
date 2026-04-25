import React, { useEffect, useRef } from 'react';
import { LineChart, Line, ReferenceLine, ResponsiveContainer, YAxis, Tooltip } from 'recharts';
import type { PolicyState } from './types';

const BREACH_THRESHOLD = 32;

function StatusBadge({ status }: { status: string }) {
  const configs: Record<string, { label: string; color: string; pulse?: boolean }> = {
    monitoring:           { label: 'Monitoring',           color: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
    approaching_threshold:{ label: 'Approaching threshold',color: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30', pulse: true },
    breach:               { label: 'BREACH DETECTED',      color: 'bg-red-500/20 text-red-300 border-red-500/30', pulse: true },
    paid:                 { label: 'PAID OUT',              color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' },
  };
  const cfg = configs[status] ?? { label: status, color: 'bg-gray-500/20 text-gray-300 border-gray-500/30' };
  return (
    <span className={`text-xs px-2 py-0.5 rounded border font-semibold uppercase tracking-wider ${cfg.color} ${cfg.pulse ? 'animate-pulse' : ''}`}>
      {cfg.label}
    </span>
  );
}

interface Props { policy: PolicyState }

export default function PanelC({ policy }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevStatus = useRef(policy.status);

  // Flash panel on breach
  useEffect(() => {
    if (policy.status === 'breach' && prevStatus.current !== 'breach' && panelRef.current) {
      panelRef.current.classList.add('animate-flash');
      setTimeout(() => panelRef.current?.classList.remove('animate-flash'), 1600);
    }
    prevStatus.current = policy.status;
  }, [policy.status]);

  const chartData = policy.history.map((e, i) => ({ i, v: e.verifiedValue }));
  const premBalance = parseInt(policy.premiumBalance || '0');
  const premUSD = premBalance / 1e6;

  return (
    <div ref={panelRef} className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Active Policy — Parametric Insurance</span>
        <StatusBadge status={policy.status} />
      </div>

      <div className="flex-1 flex flex-col gap-3 p-3 overflow-y-auto">
        {/* Policy terms */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-border/40 rounded p-2">
            <div className="text-gray-500">Policy ID</div>
            <div className="text-white font-medium">{policy.policyId}</div>
          </div>
          <div className="bg-border/40 rounded p-2">
            <div className="text-gray-500">Data type</div>
            <div className="text-white font-medium">weather.temperature_c</div>
          </div>
          <div className="bg-border/40 rounded p-2">
            <div className="text-gray-500">Location</div>
            <div className="text-white font-medium">18.9°N, 103.87°W</div>
          </div>
          <div className="bg-border/40 rounded p-2">
            <div className="text-gray-500">Condition</div>
            <div className="text-white font-medium">Temp &gt; {BREACH_THRESHOLD}°C × 3</div>
          </div>
        </div>

        {/* Current value + sparkline */}
        <div>
          <div className="flex items-end gap-3 mb-2">
            <div>
              <div className="text-xs text-gray-500 mb-1">Current verified temperature</div>
              <div className="text-3xl font-bold tabular-nums" style={{ color: policy.latestValue !== null && policy.latestValue > BREACH_THRESHOLD ? '#f87171' : '#34d399' }}>
                {policy.latestValue !== null ? `${policy.latestValue.toFixed(1)}°C` : '--'}
              </div>
            </div>
            <div className="text-xs text-gray-500 pb-1">
              Threshold: <span className="text-yellow-400">{BREACH_THRESHOLD}°C</span>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={80}>
            <LineChart data={chartData}>
              <YAxis domain={['auto', 'auto']} hide />
              <Tooltip
                contentStyle={{ background: '#161b27', border: '1px solid #1e2535', fontSize: 10 }}
                formatter={(v: number) => [`${v.toFixed(2)}°C`, 'Temp']}
                labelFormatter={() => ''}
              />
              <ReferenceLine y={BREACH_THRESHOLD} stroke="#fbbf24" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="v" stroke="#34d399" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Premium balance */}
        <div>
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Premium balance</span>
            <span className="text-white">${premUSD.toFixed(6)} USDC</span>
          </div>
          <div className="w-full h-2 bg-border rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${Math.min(100, (premBalance / (100 * 3600)) * 100)}%`,
                background: premUSD > 0.001 ? '#3b82f6' : '#f87171',
              }}
            />
          </div>
          <div className="text-xs text-gray-600 mt-0.5">Rate: 100 micro-USDC/s</div>
        </div>

        {/* Payout section */}
        {policy.lastPaid && (
          <div className="bg-purple-900/30 border border-purple-700/40 rounded p-2 text-xs space-y-1">
            <div className="text-purple-300 font-semibold">Payout executed</div>
            <div className="text-gray-400">Amount: <span className="text-white">${(parseInt(policy.lastPaid.amountUSDC) / 1e6).toFixed(2)} USDC</span></div>
            <div className="text-gray-400 break-all">Tx: <span className="text-blue-400">{policy.lastPaid.txHash}</span></div>
            <div className="text-gray-500">Justified by {policy.lastPaid.attestationIds.length} attestations</div>
            {policy.lastPaid.attestationIds.map((id, i) => (
              <div key={i} className="text-gray-600 text-xs font-mono truncate">{id}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
