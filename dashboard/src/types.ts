// ── Wire event types (mirror of dashboard-backend bus.ts) ────────────────────

export type WsMessage = { type: string; timestamp: number; payload: BusEvent };

export type BusEvent =
  // Chain events
  | { type: 'chain.sensor_registered';    sensorId: number; wallet: string; endpointUrl: string; name: string; dataTypes: string[]; lat: number; lon: number; ratePerQuery: string; txHash?: string }
  | { type: 'chain.sensor_deactivated';   sensorId: number; txHash?: string }
  | { type: 'chain.reputation_updated';   sensorId: number; newReputation: string; delta: string; txHash?: string }
  | { type: 'chain.slashed';              sensorId: number; amount: string; remainingStake: string; autoDeactivated: boolean; txHash?: string }
  | { type: 'chain.operator_paid';        customer: string; sensorId: number; sensorWallet: string; amount: string; queryId: string; txHash?: string }
  | { type: 'chain.protocol_fee';         customer: string; amount: string; queryId: string; txHash?: string }
  | { type: 'chain.attestation_posted';   attestationId: string; dataType: string; lat: number; lon: number; timestamp: number; confidenceBps: number; txHash?: string }
  | { type: 'chain.datatype_registered';  id: string; unit: string; txHash?: string }
  // Aggregator events
  | { type: 'query.received';             customer: string; params: Record<string, unknown>; selectedSensorIds: number[] }
  | { type: 'query.sensor_payment';       sensorId: number; wallet: string; amount: number; txHash: string }
  | { type: 'query.fee_forwarded';        amount: number; txHash: string }
  | { type: 'query.attestation_posted';   attestationId: string }
  | { type: 'query.reputation_updated';   sensorId: number; delta: string; bucket: 'accepted' | 'outlier' }
  | { type: 'query.slashed';              sensorId: number }
  | { type: 'query.completed';            response: Record<string, unknown> }
  // Insurance events
  | { type: 'insurance.snapshot';         policyId: string; status: string; premiumBalance: string; latestValue: number | null; history: ReadingEntry[]; timestamp: number }
  | { type: 'insurance.paid';             policyId: string; policyholder: string; amountUSDC: string; txHash: string; attestationIds: string[]; timestamp: number }
  // Replay banner
  | { type: 'replay.mode';                active: boolean };

export interface ReadingEntry {
  verifiedValue: number;
  attestationId: string;
  timestamp:     number;
}

// ── App state ─────────────────────────────────────────────────────────────────

export interface SensorState {
  sensorId:     number;
  name:         string;
  wallet:       string;
  lat:          number;
  lon:          number;
  dataTypes:    string[];
  ratePerQuery: number;
  reputation:   number;   // 0–1 (1e18 = 1.0)
  active:       boolean;
  earnings:     number;   // micro-USDC
  queryCount:   number;
  repHistory:   number[]; // last 20 reputation values
}

export interface SlashEvent {
  sensorId:       number;
  amount:         string;
  remainingStake: string;
  anomalyMag:     number | null;
  timestamp:      number;
}

export interface PolicyState {
  policyId:       string;
  status:         string;
  premiumBalance: string;
  latestValue:    number | null;
  history:        ReadingEntry[];
  lastPaid:       { txHash: string; attestationIds: string[]; amountUSDC: string } | null;
}

export interface AppState {
  sensors:           Map<number, SensorState>;
  txEvents:          Array<{ id: number; ts: number; event: BusEvent }>;
  totalTxCount:      number;
  totalSettlements:  number;
  operatorEarnings:  number;   // micro-USDC
  protocolTreasury:  number;   // micro-USDC
  policy:            PolicyState;
  slashEvents:       SlashEvent[];
  replayMode:        boolean;
  wsConnected:       boolean;
}

// Sensor metadata is sourced entirely from the on-chain SensorRegistered event
// (name field added to the contract) — no static config. The indexer backfills
// historical registrations on startup so the dashboard self-populates.

export const PLANNED_SENSORS = [
  { name: 'Seismic (planned)',   lat: 19.28, lon: -103.60, type: 'seismic.velocity_mms' },
  { name: 'Radiation (planned)', lat: 18.80, lon: -104.20, type: 'radiation.dose_usvh' },
];
