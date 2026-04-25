/**
 * demo-adversarial.ts — 4 honest + 1 rogue operator. Narrates each milestone.
 *
 * Usage: npm run demo:adversarial
 *
 * Timeline:
 *  T+0s   All 5 operators start honest
 *  T+60s  Operator 5 flipped rogue (bias = +20°C) via admin endpoint
 *  T+?s   Aggregator detects outliers, reputation decrements
 *  T+?s   Operator 5 reputation drops below SLASH_THRESHOLD → slashed
 *  T+?s   Honest quorum (4 sensors) confirms breach → payout
 *
 * The script prints live narration matching the pitch deck slide 4.
 */
import 'dotenv/config';
import axios from 'axios';
import {
  startOperators, startAggregator, startDashboardBackend, startInsuranceAgent,
  waitForHttp, sleep, setupShutdown, stopAll,
  AGGREGATOR_PORT, DASHBOARD_HTTP_PORT, DASHBOARD_WS_PORT, SENSOR_CONFIGS, OPERATOR5_PORT,
} from './lib/services.js';
import { WebSocket } from 'ws';

const DEMO_INTERVAL_MS  = 15_000;
const ROGUE_DELAY_MS    = 60_000;   // flip Operator 5 at T+60s
const ROGUE_BIAS        = 20;       // +20°C — will be a clear outlier
const MAX_RUNTIME_MS    = 30 * 60 * 1000;

// ── Narration ─────────────────────────────────────────────────────────────────

function narrate(msg: string): void {
  const ts = new Date().toLocaleTimeString('en', { hour12: false });
  console.log(`\n  [${ts}] 🎙  ${msg}`);
}

// ── Watch WS for key events ───────────────────────────────────────────────────

interface WsMsg { type: string; payload: Record<string, unknown> }

function watchEvents(): () => void {
  let ws: WebSocket;

  function connect() {
    ws = new WebSocket(`ws://localhost:${DASHBOARD_WS_PORT}`);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMsg;
        const p   = msg.payload;
        switch (msg.type) {
          case 'query.completed':
            narrate(`Query completed — verified value: ${(p['verifiedValue'] as number)?.toFixed(2)}°C  confidence: ${((p['confidence'] as number) * 100).toFixed(0)}%`);
            break;
          case 'chain.reputation_updated': {
            const rep   = Number(BigInt(p['newReputation'] as string)) / 1e18;
            const delta = BigInt(p['delta'] as string);
            if (delta < 0n) narrate(`⚠  Sensor #${p['sensorId']} reputation → ${(rep * 100).toFixed(1)}%  (outlier penalty)`);
            break;
          }
          case 'chain.slashed':
            narrate(`⚡ SLASHING EVENT — Sensor #${p['sensorId']} slashed! Stake seized. Auto-deactivated: ${p['autoDeactivated']}`);
            break;
          case 'insurance.paid':
            narrate(`🎯 PAYOUT EXECUTED — ${((parseInt(p['amountUSDC'] as string)) / 1e6).toFixed(2)} USDC → policyholder\n     Tx: ${p['txHash']}`);
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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  setupShutdown();

  console.log('\n=== Cairn Demo: Adversarial Scenario ===\n');
  console.log('Dashboard:     http://localhost:5173');
  console.log('Aggregator:    http://localhost:' + AGGREGATOR_PORT);
  console.log('');
  narrate('Starting all services…');

  // Dashboard backend
  startDashboardBackend();
  await waitForHttp(`http://localhost:${DASHBOARD_HTTP_PORT}/health`, 'Dashboard backend');

  // 5 operators (all honest at start)
  startOperators();
  await Promise.all(
    SENSOR_CONFIGS.map(({ n, port }) =>
      waitForHttp(`http://localhost:${port}/health`, `Operator ${n}`, 45_000),
    ),
  );

  // Aggregator
  startAggregator();
  await waitForHttp(`http://localhost:${AGGREGATOR_PORT}/health`, 'Aggregator', 30_000);

  // Insurance agent (faster interval for demo)
  startInsuranceAgent(DEMO_INTERVAL_MS);

  narrate('All 5 operators running honestly. Insurance agent querying every 15 seconds.');
  narrate(`Operator 5 will go rogue in ${ROGUE_DELAY_MS / 1000} seconds…`);

  // Watch WS events and narrate
  const stopWatch = watchEvents();

  // T+60s: flip Operator 5 rogue
  await sleep(ROGUE_DELAY_MS);
  try {
    await axios.post(`http://localhost:${OPERATOR5_PORT}/admin/set-bias`, { biasOffset: ROGUE_BIAS });
    narrate(`Operator 5 flipped ROGUE — bias injected: +${ROGUE_BIAS}°C 🔴`);
    narrate('Watch the slashing feed on the dashboard…');
  } catch (err) {
    console.error('  Failed to flip Operator 5 rogue:', err);
    narrate('Could not reach Operator 5 admin endpoint — check OPERATOR5_PORT');
  }

  // Wait for payout or timeout
  const deadline = Date.now() + MAX_RUNTIME_MS;
  while (Date.now() < deadline) {
    await sleep(5_000);
  }

  narrate('Max runtime reached. Stopping all services.');
  stopWatch();
  stopAll();
  process.exit(0);
}

main().catch(err => {
  console.error('\nDemo failed:', err);
  stopAll();
  process.exit(1);
});
