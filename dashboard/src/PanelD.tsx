import React from 'react';
import type { SlashEvent, SensorState } from './types';

interface Props {
  slashEvents: SlashEvent[];
  sensors:     Map<number, SensorState>;
}

export default function PanelD({ slashEvents, sensors }: Props) {
  if (slashEvents.length === 0) {
    return (
      <div className="panel flex flex-col h-full">
        <div className="panel-header">
          <span>Slashing Feed</span>
          <span className="text-xs text-gray-600">No slashing events</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-gray-700 text-xs">
          Sensors behaving honestly
        </div>
      </div>
    );
  }

  return (
    <div className="panel flex flex-col h-full border-red-700/40">
      <div className="panel-header bg-red-900/20">
        <span className="text-red-400">⚡ Slashing Feed</span>
        <span className="text-xs text-red-500 animate-pulse">{slashEvents.length} event{slashEvents.length > 1 ? 's' : ''}</span>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-border">
        {slashEvents.map((ev, i) => {
          const sensor    = sensors.get(ev.sensorId);
          const stakeUSD  = parseInt(ev.amount || '0') / 1e6;
          const remaining = parseInt(ev.remainingStake || '0') / 1e6;
          const rep       = sensor?.reputation ?? null;
          return (
            <div key={i} className="p-3 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-red-400 text-lg">⚡</span>
                  <div>
                    <div className="text-sm font-semibold text-white">
                      Sensor #{ev.sensorId} — {sensor?.name ?? 'Unknown'}
                    </div>
                    <div className="text-xs text-gray-500">
                      {new Date(ev.timestamp).toLocaleTimeString('en', { hour12: false })}
                    </div>
                  </div>
                </div>
                {rep !== null && (
                  <div className="text-right">
                    <div className="text-xs text-gray-500">Reputation</div>
                    <div className="text-sm font-bold text-red-400">{(rep * 100).toFixed(1)}%</div>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                {ev.anomalyMag !== null && (
                  <div className="bg-red-900/20 rounded p-2">
                    <div className="text-gray-500">Anomaly magnitude</div>
                    <div className="text-red-300 font-semibold">{ev.anomalyMag.toFixed(2)}σ</div>
                  </div>
                )}
                {stakeUSD > 0 && (
                  <div className="bg-border/40 rounded p-2">
                    <div className="text-gray-500">Stake slashed</div>
                    <div className="text-white font-semibold">${stakeUSD.toFixed(2)} USDC</div>
                  </div>
                )}
                {remaining > 0 && (
                  <div className="bg-border/40 rounded p-2">
                    <div className="text-gray-500">Remaining stake</div>
                    <div className="text-yellow-400 font-semibold">${remaining.toFixed(2)} USDC</div>
                  </div>
                )}
                {sensor && !sensor.active && (
                  <div className="bg-red-900/20 rounded p-2 col-span-2">
                    <div className="text-red-400 text-center">Sensor auto-deactivated</div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
