/**
 * Generates dashboard/public/demo.json — a synthetic but realistic recording
 * of the full adversarial scenario for the Vercel static demo.
 *
 * Scenario:
 *   T+0s    5 sensors registered, honest operation begins (29.5°C)
 *   T+15s   Cycles 1-3: honest readings, payments, attestations
 *   T+60s   Sensor 5 (Tecomán-02) injected with +20°C bias
 *           Temperature also rises to 33.5°C (genuine heat event)
 *   T+75s   Cycle 4+: sensor 5 flagged as outlier each cycle
 *           Verified value = honest 33.5°C → breach condition met
 *   T+120s  3 consecutive breach readings → insurance payout triggered
 *   T+285s  Sensor 5 reputation < 30% → SLASHED, auto-deactivated
 */
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'dashboard', 'public', 'demo.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

let nowMs = 0;
let lastMs = 0;
const events: { deltaMs: number; message: unknown }[] = [];

function emit(payload: unknown, atMs = nowMs) {
  const deltaMs = atMs - lastMs;
  lastMs = atMs;
  events.push({
    deltaMs: Math.max(0, deltaMs),
    message: { type: (payload as { type: string }).type, timestamp: atMs, payload },
  });
}

function hex(n: number): string {
  return n.toString(16).padStart(64, '0');
}
function addr(n: number): string {
  return '0x' + n.toString(16).padStart(40, '0');
}
function hash(n: number): string {
  return '0x' + (n * 7_919 + 0xdeadbeef).toString(16).padStart(64, '0').slice(0, 64);
}

// ── Sensor metadata ───────────────────────────────────────────────────────────

const SENSORS = [
  { sensorId: 1, name: 'Tecomán-01',  lat: 18.90, lon: -103.87, wallet: addr(0xa1), rate: 100 },
  { sensorId: 2, name: 'Colima City', lat: 19.24, lon: -103.72, wallet: addr(0xa2), rate: 100 },
  { sensorId: 3, name: 'Manzanillo',  lat: 19.11, lon: -104.34, wallet: addr(0xa3), rate: 100 },
  { sensorId: 4, name: 'Armería',     lat: 18.93, lon: -103.96, wallet: addr(0xa4), rate: 100 },
  { sensorId: 5, name: 'Tecomán-02',  lat: 18.91, lon: -103.88, wallet: addr(0xa5), rate: 100 },
];

const CUSTOMER  = addr(0xc0);
const TREASURY  = addr(0xfe);
const DATA_TYPE = 'weather.temperature_c';
const HONEST_TEMP  = 29.5;
const BREACH_TEMP  = 33.5;
const ROGUE_BIAS   = 20;

// Reputation tracking
const rep: Record<number, bigint> = {};
for (const s of SENSORS) rep[s.sensorId] = BigInt('1000000000000000000'); // 1e18
const ACCEPTED_DELTA = BigInt('10000000000000000');   //  +1e16
const OUTLIER_DELTA  = BigInt('-50000000000000000');  //  -5e16
const SLASH_THRESHOLD = BigInt('300000000000000000'); //   3e17
const INITIAL_STAKE  = 10_000_000; // 10 USDC in micro

let stakeRemaining: Record<number, number> = {};
for (const s of SENSORS) stakeRemaining[s.sensorId] = INITIAL_STAKE;

let seqId = 1;
function nextId() { return seqId++; }

// ── Phase 0: Registrations ────────────────────────────────────────────────────

for (const s of SENSORS) {
  emit({
    type: 'chain.sensor_registered',
    sensorId: s.sensorId,
    wallet: s.wallet,
    endpointUrl: `http://localhost:${3000 + s.sensorId}`,
    dataTypes: [DATA_TYPE, 'weather.humidity_pct'],
    lat: s.lat,
    lon: s.lon,
    ratePerQuery: s.rate.toString(),
  }, nowMs);
  nowMs += 400;
}

// ── Cycle generator ───────────────────────────────────────────────────────────

function runCycle(cycleMs: number, temp: number, rogueActive: boolean) {
  const qId = hash(nextId());
  const attId = hash(nextId() + 10_000);
  const outlierSensorId = rogueActive ? 5 : null;
  const selectedIds = SENSORS.map(s => s.sensorId);

  // query.received
  emit({
    type: 'query.received',
    customer: CUSTOMER,
    params: { dataType: DATA_TYPE, lat: 18.9, lon: -103.87, quorum: 5 },
    selectedSensorIds: selectedIds,
  }, cycleMs);

  // x402 payments to each sensor (fast, within ~1s)
  let payOffset = 200;
  for (const s of SENSORS) {
    const txH = hash(nextId());
    emit({
      type: 'query.sensor_payment',
      sensorId: s.sensorId,
      wallet: s.wallet,
      amount: s.rate,
      txHash: txH,
    }, cycleMs + payOffset);
    payOffset += 150;
  }

  // protocol fee
  const baseTotal = SENSORS.reduce((a, s) => a + s.rate, 0);
  const fee = Math.ceil(baseTotal * 200 / 10000);
  emit({
    type: 'query.fee_forwarded',
    amount: fee,
    txHash: hash(nextId()),
  }, cycleMs + payOffset);

  // query.completed
  const verifiedValue = temp; // honest consensus excludes outlier
  emit({
    type: 'query.completed',
    response: {
      verifiedValue,
      dataType: DATA_TYPE,
      unit: 'degC',
      timestamp: Math.floor((cycleMs + 800) / 1000),
      attestationId: attId,
      contributingSensors: selectedIds.filter(id => id !== outlierSensorId),
      excludedSensors: outlierSensorId ? [outlierSensorId] : [],
      confidence: outlierSensorId ? 0.82 : 0.96,
      totalPaidUSDC: ((baseTotal + fee) / 1e6).toFixed(6),
    },
  }, cycleMs + 900);

  // query.attestation_posted
  emit({ type: 'query.attestation_posted', attestationId: attId }, cycleMs + 950);

  // reputation updates (aggregator-side)
  let repOffset = 1000;
  for (const s of SENSORS) {
    const bucket = s.sensorId === outlierSensorId ? 'outlier' : 'accepted';
    emit({
      type: 'query.reputation_updated',
      sensorId: s.sensorId,
      delta: (s.sensorId === outlierSensorId ? OUTLIER_DELTA : ACCEPTED_DELTA).toString(),
      bucket,
    }, cycleMs + repOffset);
    repOffset += 100;
  }

  // on-chain confirmations (~3s after cycle start)
  const chainOffset = 3000;

  // chain.operator_paid × 5
  for (const s of SENSORS) {
    emit({
      type: 'chain.operator_paid',
      customer: CUSTOMER,
      sensorId: s.sensorId,
      sensorWallet: s.wallet,
      amount: s.rate.toString(),
      queryId: qId,
    }, cycleMs + chainOffset + s.sensorId * 100);
  }

  // chain.protocol_fee
  emit({
    type: 'chain.protocol_fee',
    customer: CUSTOMER,
    amount: fee.toString(),
    queryId: qId,
  }, cycleMs + chainOffset + 600);

  // chain.attestation_posted
  emit({
    type: 'chain.attestation_posted',
    attestationId: attId,
    dataType: DATA_TYPE,
    lat: 18.9,
    lon: -103.87,
    timestamp: Math.floor(cycleMs / 1000),
    confidenceBps: Math.round((outlierSensorId ? 0.82 : 0.96) * 10000),
  }, cycleMs + chainOffset + 700);

  // chain.reputation_updated × 5 (on-chain confirmation)
  for (const s of SENSORS) {
    const delta = s.sensorId === outlierSensorId ? OUTLIER_DELTA : ACCEPTED_DELTA;
    let newRep = rep[s.sensorId] + delta;
    if (newRep < 0n) newRep = 0n;
    if (newRep > BigInt('1000000000000000000')) newRep = BigInt('1000000000000000000');
    rep[s.sensorId] = newRep;

    emit({
      type: 'chain.reputation_updated',
      sensorId: s.sensorId,
      newReputation: newRep.toString(),
      delta: delta.toString(),
    }, cycleMs + chainOffset + 800 + s.sensorId * 150);

    // Check slash
    if (s.sensorId === outlierSensorId && newRep < SLASH_THRESHOLD) {
      const slashAmt = Math.min(2_000_000, stakeRemaining[s.sensorId]);
      stakeRemaining[s.sensorId] -= slashAmt;
      const autoDeact = stakeRemaining[s.sensorId] < 4_000_000;

      emit({
        type: 'chain.slashed',
        sensorId: s.sensorId,
        amount: slashAmt.toString(),
        remainingStake: stakeRemaining[s.sensorId].toString(),
        autoDeactivated: autoDeact,
      }, cycleMs + chainOffset + 1200);

      if (autoDeact) {
        emit({ type: 'chain.sensor_deactivated', sensorId: s.sensorId },
          cycleMs + chainOffset + 1300);
      }
    }
  }
}

// ── Phase 1: 3 honest cycles at 29.5°C ───────────────────────────────────────

const insuranceHistory: { verifiedValue: number; attestationId: string; timestamp: number }[] = [];
let premiumBalance = 360_000; // 100 micro-USDC/s × 3600s
const PREMIUM_RATE = 100; // micro-USDC/s
const CYCLE_MS = 15_000;

for (let c = 0; c < 3; c++) {
  const cycleMs = 5000 + c * CYCLE_MS;
  runCycle(cycleMs, HONEST_TEMP, false);

  premiumBalance -= PREMIUM_RATE * 15;
  const attId = hash(c + 50_000);
  insuranceHistory.push({ verifiedValue: HONEST_TEMP, attestationId: attId, timestamp: Math.floor(cycleMs / 1000) });

  emit({
    type: 'insurance.snapshot',
    policyId: 'policy-001',
    status: 'monitoring',
    premiumBalance: premiumBalance.toString(),
    latestValue: HONEST_TEMP,
    history: [...insuranceHistory],
    timestamp: Math.floor(cycleMs / 1000),
  }, cycleMs + 1500);
}

// ── Phase 2: Rogue sensor activated + temperature rises ───────────────────────

// T=50s: inject rogue (narrated separately; no explicit event)
// Cycles 4-17: sensor 5 is outlier, honest temp = 33.5°C

let breachCount = 0;
let paid = false;

for (let c = 0; c < 14; c++) {
  const cycleMs = 50_000 + c * CYCLE_MS;
  runCycle(cycleMs, BREACH_TEMP, true);

  premiumBalance -= PREMIUM_RATE * 15;
  const attId = hash(c + 60_000);
  insuranceHistory.push({ verifiedValue: BREACH_TEMP, attestationId: attId, timestamp: Math.floor(cycleMs / 1000) });
  if (insuranceHistory.length > 20) insuranceHistory.shift();

  // Breach condition: temp > 32°C for 3 consecutive
  if (BREACH_TEMP > 32) breachCount++;

  const status = paid ? 'paid'
    : breachCount >= 3  ? 'breach'
    : BREACH_TEMP > 32  ? 'approaching_threshold'
    : 'monitoring';

  emit({
    type: 'insurance.snapshot',
    policyId: 'policy-001',
    status,
    premiumBalance: premiumBalance.toString(),
    latestValue: BREACH_TEMP,
    history: [...insuranceHistory],
    timestamp: Math.floor(cycleMs / 1000),
  }, cycleMs + 1500);

  // Insurance payout after 3 consecutive breach readings
  if (breachCount === 3 && !paid) {
    paid = true;
    const payoutTx = '0x' + 'b'.repeat(64);
    const attestIds = insuranceHistory.slice(-3).map(e => e.attestationId);

    emit({
      type: 'insurance.paid',
      policyId: 'policy-001',
      policyholder: addr(0xb0),
      amountUSDC: '10000000', // 10 USDC
      txHash: payoutTx,
      attestationIds: attestIds,
      timestamp: Math.floor((cycleMs + 2000) / 1000),
    }, cycleMs + 2000);
  }
}

// ── Write output ──────────────────────────────────────────────────────────────

writeFileSync(OUT, JSON.stringify(events, null, 2));
console.log(`✓ Wrote ${events.length} events to ${OUT}`);
console.log(`  Duration: ${(lastMs / 1000).toFixed(1)}s at 1× speed`);
