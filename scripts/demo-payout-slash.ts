/**
 * demo-payout-slash.ts — scripted scenario that reliably produces BOTH events.
 *
 * Usage: npm run demo:payout-slash
 *
 * Timeline (cycle = 15s, insurance queries every 15s):
 *   T+0s    All services start. 5 operators honest. Real OWM weather.
 *   T+30s   "Heatwave" — bias +15°C applied to ALL 5 sensors so the median
 *           (verified value) lands >32°C. Insurance starts seeing breach.
 *   T+~75s  After 3 consecutive breach readings → insurance payout executes.
 *   T+90s   Sensor 5 receives an EXTRA +20°C bias on top of the heatwave
 *           (bias = +35°C total). It now reads far above the honest median
 *           and is flagged as an outlier every cycle.
 *   T+~5min Sensor 5 reputation falls below SLASH_THRESHOLD (3e17) → slashed.
 *
 * The script exits when both events have been observed (or MAX_RUNTIME_MS).
 *
 * Run the recorder in parallel to capture the full event stream:
 *   npm run demo:record dashboard/public/demo.json
 */
import 'dotenv/config';
import axios from 'axios';
import {
  startOperators, startAggregator, startDashboardBackend, startInsuranceAgent,
  waitForHttp, sleep, setupShutdown, stopAll,
  AGGREGATOR_PORT, DASHBOARD_HTTP_PORT, DASHBOARD_WS_PORT, SENSOR_CONFIGS,
} from './lib/services.js';
import { WebSocket } from 'ws';

const DEMO_INTERVAL_MS = 20_000;
const HEATWAVE_DELAY   = 30_000;             // T+30s: bias all sensors
const ROGUE_DELAY      = 90_000;             // T+90s: sensor 5 goes extra-rogue
const HEATWAVE_BIAS    = 15;                 // °C — pushes verified value >32°C
const ROGUE_EXTRA_BIAS = 20;                 // °C — additive on top of heatwave
const MAX_RUNTIME_MS   = 15 * 60 * 1000;     // 15-minute hard stop

// Reduce aggregator tx pressure (Arc testnet txpool is small): skip the
// on-chain rep bumps for accepted sensors during the demo.
process.env['AGGREGATOR_SKIP_HONEST_REP'] = 'true';

function narrate(msg: string): void {
  const ts = new Date().toLocaleTimeString('en', { hour12: false });
  console.log(`\n  [${ts}] 🎙  ${msg}`);
}

interface WsMsg { type: string; payload: Record<string, unknown> }

function watchEvents(state: { paid: boolean; slashed: boolean }): () => void {
  let ws: WebSocket;
  function connect() {
    ws = new WebSocket(`ws://localhost:${DASHBOARD_WS_PORT}`);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMsg;
        const p   = msg.payload;
        switch (msg.type) {
          case 'query.completed':
            narrate(`Query completed — verified: ${(p['verifiedValue'] as number)?.toFixed(2)}°C  confidence: ${((p['confidence'] as number) * 100).toFixed(0)}%`);
            break;
          case 'chain.reputation_updated': {
            const rep   = Number(BigInt(p['newReputation'] as string)) / 1e18;
            const delta = BigInt(p['delta'] as string);
            if (delta < 0n) narrate(`⚠  Sensor #${p['sensorId']} reputation → ${(rep * 100).toFixed(1)}%`);
            break;
          }
          case 'chain.slashed':
            narrate(`⚡ SLASH — Sensor #${p['sensorId']} slashed. Auto-deactivated: ${p['autoDeactivated']}`);
            state.slashed = true;
            break;
          case 'insurance.paid':
            narrate(`🎯 PAYOUT — ${((parseInt(p['amountUSDC'] as string)) / 1e6).toFixed(2)} USDC → policyholder\n     Tx: ${p['txHash']}`);
            state.paid = true;
            break;
        }
      } catch { /* ignore */ }
    });
    ws.on('close', () => setTimeout(connect, 1000));
    ws.on('error', () => {});
  }
  connect();
  return () => ws?.close();
}

async function setBias(port: number, offset: number, label: string): Promise<void> {
  try {
    await axios.post(`http://localhost:${port}/admin/set-bias`, { offset });
    narrate(`bias(${label}) ← ${offset >= 0 ? '+' : ''}${offset}°C`);
  } catch (err) {
    console.error(`  Failed to set bias on ${label}:`, (err as Error).message);
  }
}

async function main() {
  setupShutdown();

  console.log('\n=== Cairn Demo: Payout + Slash (scripted weather) ===\n');
  console.log('Dashboard:    http://localhost:5173');
  console.log('Aggregator:   http://localhost:' + AGGREGATOR_PORT);
  console.log('Dashboard WS: ws://localhost:' + DASHBOARD_WS_PORT);
  console.log('');

  startDashboardBackend();
  await waitForHttp(`http://localhost:${DASHBOARD_HTTP_PORT}/health`, 'Dashboard backend');

  startOperators();
  await Promise.all(
    SENSOR_CONFIGS.map(({ n, port }) =>
      waitForHttp(`http://localhost:${port}/health`, `Operator ${n}`, 45_000),
    ),
  );

  startAggregator();
  await waitForHttp(`http://localhost:${AGGREGATOR_PORT}/health`, 'Aggregator', 30_000);

  startInsuranceAgent(DEMO_INTERVAL_MS);

  narrate('All 5 operators honest. Insurance agent querying every 15s.');
  narrate(`Heatwave bias (+${HEATWAVE_BIAS}°C all sensors) in ${HEATWAVE_DELAY / 1000}s.`);
  narrate(`Rogue extra bias (+${ROGUE_EXTRA_BIAS}°C on sensor 5) in ${ROGUE_DELAY / 1000}s.`);

  const state = { paid: false, slashed: false };
  const stopWatch = watchEvents(state);

  // ── T+30s: heatwave ─────────────────────────────────────────────────────────
  await sleep(HEATWAVE_DELAY);
  narrate('Heatwave begins — biasing all 5 sensors.');
  await Promise.all(
    SENSOR_CONFIGS.map(({ n, port }) => setBias(port, HEATWAVE_BIAS, `op${n}`)),
  );

  // ── T+90s: sensor 5 goes extra-rogue ────────────────────────────────────────
  await sleep(ROGUE_DELAY - HEATWAVE_DELAY);
  narrate('Sensor 5 going rogue — extra bias applied.');
  const op5 = SENSOR_CONFIGS.find((s) => s.n === 5)!;
  await setBias(op5.port, HEATWAVE_BIAS + ROGUE_EXTRA_BIAS, 'op5');

  // ── Wait for both payout and slash, or hard timeout ─────────────────────────
  const deadline = Date.now() + MAX_RUNTIME_MS - ROGUE_DELAY;
  while (Date.now() < deadline) {
    if (state.paid && state.slashed) {
      narrate('Both events observed. Keeping services up 30s longer so trailing chain.* events flush…');
      await sleep(30_000);
      break;
    }
    await sleep(5_000);
  }

  narrate('Stopping all services.');
  stopWatch();
  stopAll();
  process.exit(0);
}

main().catch(err => {
  console.error('\nDemo failed:', err);
  stopAll();
  process.exit(1);
});
