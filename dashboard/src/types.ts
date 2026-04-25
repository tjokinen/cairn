// ── Wire event types (mirror of dashboard-backend bus.ts) ────────────────────

export type WsMessage = { type: string; timestamp: number; payload: BusEvent };

export type BusEvent =
  // Chain events
  | { type: 'chain.sensor_registered';    sensorId: number; wallet: string; endpointUrl: string; dataTypes: string[]; lat: number; lon: number; ratePerQuery: string }
  | { type: 'chain.sensor_deactivated';   sensorId: number }
  | { type: 'chain.reputation_updated';   sensorId: number; newReputation: string; delta: string }
  | { type: 'chain.slashed';              sensorId: number; amount: string; remainingStake: string; autoDeactivated: boolean }
  | { type: 'chain.operator_paid';        customer: string; sensorId: number; sensorWallet: string; amount: string; queryId: string }
  | { type: 'chain.protocol_fee';         customer: string; amount: string; queryId: string }
  | { type: 'chain.attestation_posted';   attestationId: string; dataType: string; lat: number; lon: number; timestamp: number; confidenceBps: number }
  | { type: 'chain.datatype_registered';  id: string; unit: string }
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

// ── Static sensor metadata (registered at deploy time) ───────────────────────

export const STATIC_SENSORS: Omit<SensorState, 'reputation' | 'active' | 'earnings' | 'queryCount' | 'repHistory'>[] = [
  { sensorId: 1, name: 'Tecomán-01',  wallet: '', lat: 18.90, lon: -103.87, dataTypes: ['weather.temperature_c','weather.humidity_pct','weather.precipitation_mm_h','weather.wind_ms'], ratePerQuery: 100 },
  { sensorId: 2, name: 'Colima City', wallet: '', lat: 19.24, lon: -103.72, dataTypes: ['weather.temperature_c','weather.humidity_pct','weather.precipitation_mm_h','weather.wind_ms'], ratePerQuery: 100 },
  { sensorId: 3, name: 'Manzanillo',  wallet: '', lat: 19.11, lon: -104.34, dataTypes: ['weather.temperature_c','weather.humidity_pct','weather.precipitation_mm_h','weather.wind_ms'], ratePerQuery: 100 },
  { sensorId: 4, name: 'Armería',     wallet: '', lat: 18.93, lon: -103.96, dataTypes: ['weather.temperature_c','weather.humidity_pct','weather.precipitation_mm_h','weather.wind_ms','air.pm25_ugm3','air.pm10_ugm3'], ratePerQuery: 100 },
  { sensorId: 5, name: 'Tecomán-02',  wallet: '', lat: 18.91, lon: -103.88, dataTypes: ['weather.temperature_c','weather.humidity_pct','weather.precipitation_mm_h','weather.wind_ms'], ratePerQuery: 100 },
];

export const PLANNED_SENSORS = [
  { name: 'Seismic (planned)',   lat: 19.28, lon: -103.60, type: 'seismic.velocity_mms' },
  { name: 'Radiation (planned)', lat: 18.80, lon: -104.20, type: 'radiation.dose_usvh' },
];
