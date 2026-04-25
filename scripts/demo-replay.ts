/**
 * demo-replay.ts — replays a recorded event stream to the dashboard backend.
 *
 * Usage: npm run demo:replay [recording-file]
 *
 * Default input: scripts/recorded-demo.json
 *
 * What it does:
 *  1. Sends { type: 'replay.mode', active: true } to show the REPLAY MODE banner
 *  2. Replays each event to dashboard-backend POST /events/batch in time-accurate order
 *  3. Sends { type: 'replay.mode', active: false } when done
 *
 * The dashboard shows a "⏪ REPLAY MODE" banner while replay is active.
 * Visually indistinguishable from a live run except for the banner.
 *
 * Prerequisites: dashboard backend must be running (it doesn't need live services).
 *   tsx dashboard-backend/src/index.ts
 */
import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname }         from 'path';
import { fileURLToPath }            from 'url';
import axios                        from 'axios';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const HTTP_PORT      = parseInt(process.env['DASHBOARD_HTTP_PORT'] ?? '5001');
const BACKEND_URL    = `http://localhost:${HTTP_PORT}`;
const INPUT          = process.argv[2] ?? resolve(__dirname, 'recorded-demo.json');
const SPEED          = parseFloat(process.argv[3] ?? '1.0'); // 2.0 = 2× faster

interface RecordedEvent {
  wallTimeMs: number;
  deltaMs:    number;
  message:    unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function post(payload: unknown): Promise<void> {
  await axios.post(`${BACKEND_URL}/events`, payload, { timeout: 3000 });
}

async function main() {
  console.log(`\n=== Cairn Demo Replay ===`);
  console.log(`Input:   ${INPUT}`);
  console.log(`Speed:   ${SPEED}× (pass a second arg to change, e.g. "2.0" for 2× faster)`);
  console.log(`Backend: ${BACKEND_URL}\n`);

  if (!existsSync(INPUT)) {
    console.error(`Recording file not found: ${INPUT}`);
    console.error('Run `npm run demo:record` during a live demo first.');
    process.exit(1);
  }

  const events: RecordedEvent[] = JSON.parse(readFileSync(INPUT, 'utf8'));
  if (events.length === 0) {
    console.error('Recording is empty.');
    process.exit(1);
  }

  // Verify dashboard backend is reachable
  try {
    await axios.get(`${BACKEND_URL}/health`, { timeout: 3000 });
    console.log('✓ Dashboard backend reachable\n');
  } catch {
    console.error(`Dashboard backend not reachable at ${BACKEND_URL}/health`);
    console.error('Start it with: npm run --workspace=@cairn/dashboard-backend start');
    process.exit(1);
  }

  const totalDurationS = ((events.at(-1)!.wallTimeMs - events[0].wallTimeMs) / 1000 / SPEED).toFixed(1);
  console.log(`Replaying ${events.length} events (~${totalDurationS}s at ${SPEED}×)…\n`);

  // Show REPLAY MODE banner on dashboard
  await post({ type: 'replay.mode', active: true });

  let played = 0;
  for (const event of events) {
    const waitMs = event.deltaMs / SPEED;
    if (waitMs > 10) await sleep(waitMs);

    const payload = (event.message as { payload?: unknown })?.payload ?? event.message;
    try {
      await post(payload);
      played++;
      const pct  = ((played / events.length) * 100).toFixed(0);
      const type = (payload as { type?: string })?.type ?? '?';
      process.stdout.write(`  [${pct}%] ${type}\r`);
    } catch (err) {
      console.error(`\n  Failed to post event: ${(err as Error).message}`);
    }
  }

  process.stdout.write('\n');

  // Clear REPLAY MODE banner
  await post({ type: 'replay.mode', active: false });

  console.log(`\n✓ Replay complete — ${played}/${events.length} events delivered.\n`);
}

main().catch(err => {
  console.error('Replay failed:', err);
  process.exit(1);
});
