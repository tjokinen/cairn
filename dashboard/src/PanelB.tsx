import React from 'react';
import type { BusEvent } from './types';

interface TxEntry { id: number; ts: number; event: BusEvent }

interface Props {
  events:           TxEntry[];
  totalTxCount:     number;
  totalSettlements: number;
  operatorEarnings: number;
  protocolTreasury: number;
}

function eventColor(type: string): string {
  if (type.startsWith('chain.slashed') || type.startsWith('query.slashed')) return '#f87171';
  if (type.startsWith('insurance.paid'))     return '#c084fc';
  if (type.startsWith('insurance.'))         return '#818cf8';
  if (type.startsWith('chain.operator_paid') || type.startsWith('query.sensor_payment')) return '#34d399';
  if (type.startsWith('chain.protocol_fee') || type.startsWith('query.fee_forwarded'))   return '#60a5fa';
  if (type.startsWith('chain.reputation'))   return '#fbbf24';
  if (type.startsWith('query.completed'))    return '#a3e635';
  if (type.startsWith('chain.attestation') || type.startsWith('query.attestation'))      return '#38bdf8';
  return '#6b7280';
}

function eventLabel(e: BusEvent): string {
  switch (e.type) {
    case 'chain.sensor_registered':    return `Sensor #${e.sensorId} registered`;
    case 'chain.sensor_deactivated':   return `Sensor #${e.sensorId} deactivated`;
    case 'chain.reputation_updated': {
      const delta = BigInt(e.delta);
      const sign  = delta >= 0n ? '+' : '';
      return `Sensor #${e.sensorId} rep ${sign}${(Number(delta) / 1e16).toFixed(0)}%  → ${(Number(BigInt(e.newReputation)) / 1e16).toFixed(0)}%`;
    }
    case 'chain.slashed':              return `⚡ Sensor #${e.sensorId} SLASHED — stake lost: ${(parseInt(e.amount) / 1e6).toFixed(2)} USDC`;
    case 'chain.operator_paid':        return `Operator #${e.sensorId} paid $${(parseInt(e.amount) / 1e6).toFixed(6)}`;
    case 'chain.protocol_fee':         return `Protocol fee $${(parseInt(e.amount) / 1e6).toFixed(6)} → treasury`;
    case 'chain.attestation_posted':   return `Attestation posted: ${e.attestationId.slice(0, 12)}…`;
    case 'chain.datatype_registered':  return `Data type registered: ${e.id}`;
    case 'query.received':             return `Query received — ${e.selectedSensorIds.length} sensors selected`;
    case 'query.sensor_payment':       return `Nanopayment: Sensor #${e.sensorId} ← $${(e.amount / 1e6).toFixed(6)}`;
    case 'query.fee_forwarded':        return `Fee forwarded: $${(e.amount / 1e6).toFixed(6)}`;
    case 'query.attestation_posted':   return `Attestation: ${e.attestationId.slice(0, 12)}…`;
    case 'query.reputation_updated':   return `Rep update: Sensor #${e.sensorId} (${e.bucket})`;
    case 'query.slashed':              return `⚡ Sensor #${e.sensorId} slashed (aggregator)`;
    case 'query.completed':            return `Query completed — value: ${(e.response['verifiedValue'] as number)?.toFixed(2) ?? '?'}`;
    case 'insurance.snapshot':         return `Policy ${e.policyId}: ${e.status}`;
    case 'insurance.paid':             return `🎯 PAYOUT: ${(parseInt(e.amountUSDC) / 1e6).toFixed(2)} USDC → ${e.policyholder.slice(0, 8)}…`;
    case 'replay.mode':                return e.active ? 'REPLAY MODE activated' : 'Replay ended';
    default:                           return (e as { type: string }).type;
  }
}

function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center px-3 py-1.5 bg-border rounded">
      <span className="text-xs text-gray-500 uppercase tracking-wider">{label}</span>
      <span className="text-sm font-semibold text-white mt-0.5">{value}</span>
    </div>
  );
}

export default function PanelB({ events, totalTxCount, totalSettlements, operatorEarnings, protocolTreasury }: Props) {
  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header flex-col items-start gap-2 py-2">
        <span>Transaction Stream</span>
        <div className="flex gap-2 flex-wrap">
          <Counter label="On-chain txns"  value={totalTxCount.toString()} />
          <Counter label="Settlements"    value={totalSettlements.toString()} />
          <Counter label="Op. earnings"   value={`$${(operatorEarnings / 1e6).toFixed(4)}`} />
          <Counter label="Treasury"       value={`$${(protocolTreasury / 1e6).toFixed(4)}`} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto text-xs divide-y divide-border">
        {events.length === 0 && (
          <div className="p-4 text-gray-600 text-center">Waiting for events…</div>
        )}
        {events.map(({ id, ts, event }) => (
          <div key={id} className="flex items-start gap-2 px-3 py-1.5 hover:bg-border/30 transition-colors">
            <span className="text-gray-600 shrink-0 tabular-nums">
              {new Date(ts).toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
            <span
              className="shrink-0 w-2 h-2 rounded-full mt-0.5"
              style={{ background: eventColor(event.type) }}
            />
            <span className="text-gray-300 leading-relaxed">{eventLabel(event)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
