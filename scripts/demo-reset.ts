/**
 * demo-reset.ts — kills all running demo services and removes local state files
 * so the next demo run starts from a clean slate.
 *
 * Does NOT redeploy contracts or touch Circle wallets — those are stable across runs.
 * For a full re-bootstrap (new contracts, new wallets) run `npm run bootstrap`.
 *
 * Usage: npm run demo:reset
 */
import 'dotenv/config';
import { execSync }   from 'child_process';
import { existsSync, unlinkSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── Kill running services by port ─────────────────────────────────────────────

const PORTS = [
  process.env['OPERATOR1_PORT']       ?? '3001',
  process.env['OPERATOR2_PORT']       ?? '3002',
  process.env['OPERATOR3_PORT']       ?? '3003',
  process.env['OPERATOR4_PORT']       ?? '3004',
  process.env['OPERATOR5_PORT']       ?? '3005',
  process.env['AGGREGATOR_PORT']      ?? '4000',
  process.env['DASHBOARD_HTTP_PORT']  ?? '5001',
  process.env['DASHBOARD_WS_PORT']    ?? '5002',
];

function killPort(port: string): void {
  try {
    execSync(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe' });
    console.log(`  Killed process on port ${port}`);
  } catch { /* nothing was running */ }
}

// ── Clean local state files ────────────────────────────────────────────────────

function cleanStateFiles(): void {
  const stateDir = resolve(REPO_ROOT, 'sensor-operator');
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir)) {
      if (f.endsWith('.state.json')) {
        unlinkSync(resolve(stateDir, f));
        console.log(`  Removed ${f}`);
      }
    }
  }

  // Also clean up any aggregator state if present
  const aggState = resolve(REPO_ROOT, 'aggregator', 'aggregator.state.json');
  if (existsSync(aggState)) {
    unlinkSync(aggState);
    console.log('  Removed aggregator.state.json');
  }
}

// ── Reset Operator 5 bias (in case it was left rogue) ─────────────────────────

async function resetOperator5Bias(): Promise<void> {
  const port = process.env['OPERATOR5_PORT'] ?? '3005';
  try {
    const { default: axios } = await import('axios');
    await axios.post(`http://localhost:${port}/admin/set-bias`, { offset: 0 }, { timeout: 2000 });
    console.log('  Operator 5 bias reset to 0');
  } catch { /* not running */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== Cairn Demo Reset ===\n');

  console.log('Resetting Operator 5 bias (if running)…');
  await resetOperator5Bias();

  console.log('\nKilling services on demo ports…');
  for (const port of PORTS) killPort(port);

  console.log('\nCleaning local state files…');
  cleanStateFiles();

  console.log('\n✓ Reset complete. Ready for next demo run.\n');
}

main().catch(err => {
  console.error('Reset failed:', err);
  process.exit(1);
});
