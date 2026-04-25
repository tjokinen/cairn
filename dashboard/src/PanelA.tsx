import React, { useState } from 'react';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import type { SensorState } from './types';
import { PLANNED_SENSORS } from './types';

// ── Map coordinate helpers ────────────────────────────────────────────────────

const LAT_MIN = 18.65, LAT_MAX = 19.65;
const LON_MIN = -104.8, LON_MAX = -103.3;
const SVG_W = 480, SVG_H = 380;

function toSvg(lat: number, lon: number) {
  const x = ((lon - LON_MIN) / (LON_MAX - LON_MIN)) * SVG_W;
  const y = ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * SVG_H;
  return { x, y };
}

// Approximate polygon of Colima state (lat, lon pairs)
const COLIMA_OUTLINE: [number, number][] = [
  [19.52, -104.08], [19.60, -103.78], [19.47, -103.45], [19.18, -103.40],
  [18.85, -103.52], [18.70, -103.72], [18.72, -104.05], [18.90, -104.58],
  [19.12, -104.72], [19.35, -104.55], [19.50, -104.28], [19.52, -104.08],
];

function outlinePoints(): string {
  return COLIMA_OUTLINE.map(([lat, lon]) => {
    const { x, y } = toSvg(lat, lon);
    return `${x},${y}`;
  }).join(' ');
}

function repColor(rep: number): string {
  if (rep >= 0.7) return '#34d399';
  if (rep >= 0.3) return '#fbbf24';
  return '#f87171';
}

function iconForTypes(types: string[]): string {
  if (types.some(t => t.startsWith('air.'))) return '🌫';
  if (types.some(t => t.startsWith('seismic.'))) return '🌋';
  if (types.some(t => t.startsWith('radiation.'))) return '☢';
  return '🌡';
}

// ── Side panel ────────────────────────────────────────────────────────────────

function SidePanel({ sensor, onClose }: { sensor: SensorState; onClose: () => void }) {
  const repData = sensor.repHistory.map((v, i) => ({ i, v }));
  return (
    <div className="absolute top-0 right-0 w-56 h-full bg-panel border-l border-border z-10 p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-sm text-white">{sensor.name}</span>
        <button onClick={onClose} className="text-gray-500 hover:text-white text-xs">✕</button>
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        <div className="flex justify-between"><span>Reputation</span><span style={{ color: repColor(sensor.reputation) }}>{(sensor.reputation * 100).toFixed(1)}%</span></div>
        <div className="flex justify-between"><span>Status</span><span className={sensor.active ? 'text-green-400' : 'text-red-400'}>{sensor.active ? 'Active' : 'Inactive'}</span></div>
        <div className="flex justify-between"><span>Earnings</span><span className="text-white">${(sensor.earnings / 1e6).toFixed(4)}</span></div>
        <div className="flex justify-between"><span>Queries</span><span className="text-white">{sensor.queryCount}</span></div>
        <div className="flex justify-between"><span>Rate</span><span className="text-white">${(sensor.ratePerQuery / 1e6).toFixed(6)}/q</span></div>
      </div>
      <div>
        <div className="text-xs text-gray-500 mb-1">Reputation history</div>
        <ResponsiveContainer width="100%" height={50}>
          <LineChart data={repData}>
            <Line type="monotone" dataKey="v" stroke={repColor(sensor.reputation)} dot={false} strokeWidth={1.5} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div>
        <div className="text-xs text-gray-500 mb-1">Data types</div>
        <div className="flex flex-wrap gap-1">
          {sensor.dataTypes.map(t => (
            <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-border text-gray-300">{t.split('.')[0]}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Panel A ───────────────────────────────────────────────────────────────────

interface Props { sensors: Map<number, import('./types').SensorState> }

export default function PanelA({ sensors }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const selectedSensor = selected !== null ? sensors.get(selected) ?? null : null;

  return (
    <div className="panel flex flex-col h-full relative">
      <div className="panel-header">
        <span>Sensor Network — Colima, Mexico</span>
        <div className="flex gap-2 text-xs">
          <span className="rep-green">● Active</span>
          <span className="text-gray-500">○ Planned</span>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full h-full" style={{ background: '#0d1420' }}>
          {/* State outline */}
          <polygon
            points={outlinePoints()}
            fill="#1a2640"
            stroke="#2d4a7a"
            strokeWidth="1.5"
          />

          {/* Pacific coast label */}
          <text x="60" y="320" fill="#1e3a5f" fontSize="10" fontFamily="monospace">Pacific Ocean</text>

          {/* Planned (greyed) sensor pins */}
          {PLANNED_SENSORS.map((p) => {
            const { x, y } = toSvg(p.lat, p.lon);
            return (
              <g key={p.name} opacity={0.35}>
                <circle cx={x} cy={y} r={8} fill="#374151" stroke="#4b5563" strokeWidth="1" />
                <text x={x} y={y + 4} textAnchor="middle" fontSize="9" fill="#9ca3af">{p.type.startsWith('seismic') ? '🌋' : '☢'}</text>
                <text x={x} y={y + 18} textAnchor="middle" fontSize="7" fill="#6b7280">{p.name}</text>
              </g>
            );
          })}

          {/* Active sensor pins */}
          {Array.from(sensors.values()).map((sensor) => {
            const { x, y } = toSvg(sensor.lat, sensor.lon);
            const color = repColor(sensor.reputation);
            const icon  = iconForTypes(sensor.dataTypes);
            const isSelected = selected === sensor.sensorId;
            return (
              <g
                key={sensor.sensorId}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelected(isSelected ? null : sensor.sensorId)}
              >
                {/* Pulse ring when selected */}
                {isSelected && (
                  <circle cx={x} cy={y} r={16} fill="none" stroke={color} strokeWidth="1.5" opacity={0.5} />
                )}
                <circle
                  cx={x} cy={y} r={10}
                  fill={sensor.active ? '#1e293b' : '#1a1a1a'}
                  stroke={color}
                  strokeWidth={isSelected ? 2.5 : 1.5}
                  opacity={sensor.active ? 1 : 0.5}
                />
                <text x={x} y={y + 4} textAnchor="middle" fontSize="10" fill={color}>{icon}</text>
                <text x={x} y={y + 23} textAnchor="middle" fontSize="8" fill="#9ca3af">{sensor.name}</text>
                {/* Reputation mini-bar */}
                <rect x={x - 8} y={y + 13} width={16} height={2} fill="#374151" rx="1" />
                <rect x={x - 8} y={y + 13} width={sensor.reputation * 16} height={2} fill={color} rx="1" />
              </g>
            );
          })}
        </svg>

        {/* Legend */}
        <div className="absolute bottom-2 left-2 flex flex-col gap-1 bg-panel/80 rounded p-2">
          <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Reputation</div>
          <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-green-400 inline-block" /> &gt;70%</div>
          <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" /> 30–70%</div>
          <div className="flex items-center gap-2 text-xs"><span className="w-2 h-2 rounded-full bg-red-400 inline-block" /> &lt;30%</div>
        </div>
      </div>

      {/* Side panel on pin click */}
      {selectedSensor && <SidePanel sensor={selectedSensor} onClose={() => setSelected(null)} />}
    </div>
  );
}
