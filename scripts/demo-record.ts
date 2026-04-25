/**
 * demo-record.ts — captures all WebSocket events from a live demo run to a file.
 *
 * Usage: npm run demo:record [output-file]
 *
 * Default output: scripts/recorded-demo.json
 * The file can be played back with `npm run demo:replay`.
 *
 * Start a demo first (demo:honest or demo:adversarial), then run this in parallel.
 */
import 'dotenv/config';
import { writeFileSync, appendFileSync, existsSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import { WebSocket }        from 'ws';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const WS_PORT    = parseInt(process.env['DASHBOARD_WS_PORT'] ?? '5002');
const OUTPUT     = process.argv[2] ?? resolve(__dirname, 'recorded-demo.json');

interface RecordedEvent {
  wallTimeMs: number;
  deltaMs:    number;
  message:    unknown;
}

async function main() {
  console.log(`\n=== Cairn Demo Recorder ===`);
  console.log(`Connecting to ws://localhost:${WS_PORT}…`);
  console.log(`Output: ${OUTPUT}\n`);

  if (existsSync(OUTPUT)) {
    unlinkSync(OUTPUT);
    console.log('Cleared previous recording.\n');
  }

  const events: RecordedEvent[] = [];
  let startTime: number | null  = null;
  let lastTime:  number         = 0;

  const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

  ws.on('open', () => {
    startTime = Date.now();
    lastTime  = startTime;
    console.log('✓ Connected. Recording events… (Ctrl+C to stop and save)\n');
  });

  ws.on('message', (raw: Buffer) => {
    const now    = Date.now();
    const delta  = now - lastTime;
    lastTime     = now;
    let message: unknown;
    try { message = JSON.parse(raw.toString()); } catch { message = raw.toString(); }

    const entry: RecordedEvent = { wallTimeMs: now, deltaMs: delta, message };
    events.push(entry);

    const type = (message as { type?: string })?.type ?? '?';
    process.stdout.write(`  [+${((now - (startTime ?? now)) / 1000).toFixed(1)}s] ${type}\n`);
  });

  ws.on('close', () => {
    console.log(`\nWS closed. Saving ${events.length} events to ${OUTPUT}…`);
    save(events);
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    console.error('Make sure the dashboard backend is running (npm run demo:honest or demo:adversarial first).');
    process.exit(1);
  });

  // Graceful save on Ctrl+C
  process.on('SIGINT', () => {
    console.log(`\n\nStopping — saving ${events.length} events…`);
    ws.close();
    save(events);
    process.exit(0);
  });
}

function save(events: RecordedEvent[]): void {
  writeFileSync(OUTPUT, JSON.stringify(events, null, 2));
  const duration = events.length > 0
    ? ((events.at(-1)!.wallTimeMs - events[0].wallTimeMs) / 1000).toFixed(1)
    : '0';
  console.log(`✓ Saved ${events.length} events (${duration}s) to ${OUTPUT}`);
}

main().catch(err => {
  console.error('Recorder failed:', err);
  process.exit(1);
});
