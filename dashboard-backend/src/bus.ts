import { EventEmitter } from 'events';

// ── Event shapes ──────────────────────────────────────────────────────────────

// On-chain events (from indexer.ts)
export type ChainEvent =
  | { type: 'chain.sensor_registered';    sensorId: number; wallet: string; endpointUrl: string; dataTypes: string[]; lat: number; lon: number; ratePerQuery: string }
  | { type: 'chain.sensor_deactivated';   sensorId: number }
  | { type: 'chain.reputation_updated';   sensorId: number; newReputation: string; delta: string }
  | { type: 'chain.slashed';              sensorId: number; amount: string; remainingStake: string; autoDeactivated: boolean }
  | { type: 'chain.operator_paid';        customer: string; sensorId: number; sensorWallet: string; amount: string; queryId: string }
  | { type: 'chain.protocol_fee';         customer: string; amount: string; queryId: string }
  | { type: 'chain.attestation_posted';   attestationId: string; dataType: string; lat: number; lon: number; timestamp: number; confidenceBps: number }
  | { type: 'chain.datatype_registered';  id: string; unit: string };

// Aggregator events (POSTed from WP-04 aggregator via HTTP)
export type AggregatorEvent =
  | { type: 'query.received';             customer: string; params: Record<string, unknown>; selectedSensorIds: number[] }
  | { type: 'query.sensor_payment';       sensorId: number; wallet: string; amount: number; txHash: string }
  | { type: 'query.fee_forwarded';        amount: number; txHash: string }
  | { type: 'query.attestation_posted';   attestationId: string }
  | { type: 'query.reputation_updated';   sensorId: number; delta: string; bucket: 'accepted' | 'outlier' }
  | { type: 'query.slashed';              sensorId: number }
  | { type: 'query.completed';            response: Record<string, unknown> };

// Insurance agent events (POSTed from WP-06 agent via HTTP)
export type InsuranceEvent =
  | { type: 'insurance.snapshot';         policyId: string; status: string; premiumBalance: string; latestValue: number | null; history: unknown[]; timestamp: number }
  | { type: 'insurance.paid';             policyId: string; policyholder: string; amountUSDC: string; txHash: string; attestationIds: string[]; timestamp: number };

export type BusEvent = ChainEvent | AggregatorEvent | InsuranceEvent;

// ── Bus ───────────────────────────────────────────────────────────────────────

class DashboardBus extends EventEmitter {
  emit(event: 'event', payload: BusEvent): boolean {
    return super.emit('event', payload);
  }
  on(event: 'event', listener: (payload: BusEvent) => void): this {
    return super.on('event', listener);
  }
  publish(payload: BusEvent): void {
    this.emit('event', payload);
  }
}

export const bus = new DashboardBus();
