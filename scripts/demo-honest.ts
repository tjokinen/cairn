/**
 * demo-honest.ts — 5 honest operators + insurance agent until breach payout.
 *
 * Usage: npm run demo:honest
 *
 * What happens:
 *  1. Start dashboard backend (chain indexer + WS + HTTP)
 *  2. Start 5 sensor operator instances (all honest)
 *  3. Start aggregator
 *  4. Start insurance agent at 15s query interval (faster for demo)
 *  5. Wait; agent detects breach after 3 consecutive readings > 32°C
 *  6. Payout executes automatically; script prints receipt and exits cleanly
 *
 * The weather data is real (OpenWeatherMap at each operator's location).
 * For a reliable demo payout use demo:adversarial which can trigger at will.
 */
import 'dotenv/config';
import {
  startOperators, startAggregator, startDashboardBackend, startInsuranceAgent,
  waitForHttp, sleep, setupShutdown, stopAll,
  AGGREGATOR_PORT, DASHBOARD_HTTP_PORT, SENSOR_CONFIGS,
} from './lib/services.js';

const DEMO_INTERVAL_MS  = 15_000; // query every 15s for demo speed
const MAX_RUNTIME_MS    = 20 * 60 * 1000; // 20-minute hard stop

async function main() {
  setupShutdown();

  console.log('\n=== Cairn Demo: Honest Scenario ===\n');
  console.log('Dashboard:  http://localhost:5173');
  console.log('Dashboard WS: ws://localhost:5002');
  console.log('Aggregator: http://localhost:' + AGGREGATOR_PORT);
  console.log('');

  // 1. Dashboard backend
  startDashboardBackend();
  await waitForHttp(`http://localhost:${DASHBOARD_HTTP_PORT}/health`, 'Dashboard backend');

  // 2. Sensor operators
  console.log('\nStarting 5 sensor operators...');
  startOperators();
  await Promise.all(
    SENSOR_CONFIGS.map(({ n, port }) =>
      waitForHttp(`http://localhost:${port}/health`, `Operator ${n}`, 45_000),
    ),
  );

  // 3. Aggregator
  console.log('\nStarting aggregator...');
  startAggregator();
  await waitForHttp(`http://localhost:${AGGREGATOR_PORT}/health`, 'Aggregator', 30_000);

  // 4. Insurance agent
  console.log('\nStarting insurance agent (honest scenario)...');
  startInsuranceAgent(DEMO_INTERVAL_MS);

  console.log('\n✓ All services running.');
  console.log('  The insurance agent will query every 15 seconds.');
  console.log('  Breach triggers after 3 consecutive temperature readings > 32°C.');
  console.log('  Press Ctrl+C to stop.\n');

  // Wait for payout event posted to dashboard backend
  const deadline = Date.now() + MAX_RUNTIME_MS;
  while (Date.now() < deadline) {
    await sleep(5_000);
  }

  console.log('\nMax runtime reached. Stopping all services.');
  stopAll();
  process.exit(0);
}

main().catch(err => {
  console.error('\nDemo failed:', err);
  stopAll();
  process.exit(1);
});
