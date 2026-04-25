/**
 * Shared helpers for launching and managing Cairn service processes.
 */
import { spawn, ChildProcess } from 'child_process';
import { resolve, dirname }    from 'path';
import { fileURLToPath }       from 'url';
import axios                   from 'axios';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');

export const SENSOR_CONFIGS = [
  { n: 1, configPath: 'sensor-operator/configs/operator1.json', port: parseInt(process.env['OPERATOR1_PORT'] ?? '3001') },
  { n: 2, configPath: 'sensor-operator/configs/operator2.json', port: parseInt(process.env['OPERATOR2_PORT'] ?? '3002') },
  { n: 3, configPath: 'sensor-operator/configs/operator3.json', port: parseInt(process.env['OPERATOR3_PORT'] ?? '3003') },
  { n: 4, configPath: 'sensor-operator/configs/operator4.json', port: parseInt(process.env['OPERATOR4_PORT'] ?? '3004') },
  { n: 5, configPath: 'sensor-operator/configs/operator5.json', port: parseInt(process.env['OPERATOR5_PORT'] ?? '3005') },
];

export const AGGREGATOR_PORT        = parseInt(process.env['AGGREGATOR_PORT']          ?? '4000');
export const DASHBOARD_HTTP_PORT    = parseInt(process.env['DASHBOARD_HTTP_PORT']      ?? '5001');
export const DASHBOARD_WS_PORT      = parseInt(process.env['DASHBOARD_WS_PORT']        ?? '5002');
export const OPERATOR5_PORT         = parseInt(process.env['OPERATOR5_PORT']           ?? '3005');

const procs: ChildProcess[] = [];

export function spawnService(
  label:   string,
  cmd:     string,
  args:    string[],
  env:     NodeJS.ProcessEnv = {},
  cwd:     string            = REPO_ROOT,
): ChildProcess {
  const proc = spawn(cmd, args, {
    cwd,
    env:   { ...process.env, ...env },
    stdio: 'pipe',
  });

  proc.stdout?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      console.log(`  [${label}] ${line}`);
    }
  });
  proc.stderr?.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      console.error(`  [${label}!] ${line}`);
    }
  });
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`  [${label}] exited with code ${code}`);
  });

  procs.push(proc);
  return proc;
}

export function stopAll(): void {
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* already dead */ }
  }
  procs.length = 0;
}

export function setupShutdown(): void {
  process.on('SIGINT',  () => { stopAll(); process.exit(0); });
  process.on('SIGTERM', () => { stopAll(); process.exit(0); });
}

export async function waitForHttp(url: string, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await axios.get(url, { timeout: 1000, validateStatus: () => true });
      console.log(`  ✓ ${label} ready`);
      return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function startOperators(): void {
  for (const { n, configPath, port } of SENSOR_CONFIGS) {
    spawnService(
      `op${n}`,
      'node',
      ['--import', 'tsx/esm', resolve(REPO_ROOT, 'sensor-operator/src/service.ts'), resolve(REPO_ROOT, configPath)],
      { PORT: String(port), OPERATOR_PORT: String(port) },
    );
  }
}

export function startAggregator(): void {
  spawnService(
    'aggregator',
    'node',
    ['--import', 'tsx/esm', resolve(REPO_ROOT, 'aggregator/src/index.ts')],
    { AGGREGATOR_PORT: String(AGGREGATOR_PORT) },
  );
}

export function startDashboardBackend(): void {
  spawnService(
    'dashboard',
    'node',
    ['--import', 'tsx/esm', resolve(REPO_ROOT, 'dashboard-backend/src/index.ts')],
    {
      DASHBOARD_HTTP_PORT: String(DASHBOARD_HTTP_PORT),
      DASHBOARD_WS_PORT:   String(DASHBOARD_WS_PORT),
    },
  );
}

export function startInsuranceAgent(intervalMs = 30_000): void {
  spawnService(
    'insurance',
    'node',
    ['--import', 'tsx/esm', resolve(REPO_ROOT, 'agent-insurance/src/index.ts')],
    {
      AGGREGATOR_URL:        `http://localhost:${AGGREGATOR_PORT}`,
      DASHBOARD_BACKEND_URL: `http://localhost:${DASHBOARD_HTTP_PORT}`,
      INTERVAL_MS:           String(intervalMs),
      POLICYHOLDER_ADDRESS:  process.env['POLICYHOLDER_ADDRESS'] ?? '',
    },
  );
}
