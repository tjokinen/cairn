import 'dotenv/config';
import { readFileSync }   from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }  from 'url';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { loadDeployments } from '@cairn/common';
import { InsuranceRunner } from './runner.js';
import type { Policy }     from './runner.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..', '..');

// ── Config ────────────────────────────────────────────────────────────────────

const POLICY_PATH    = process.env['POLICY_PATH']    ?? resolve(REPO_ROOT, 'agent-insurance/policy.json');
const AGGREGATOR_URL = process.env['AGGREGATOR_URL'] ?? 'http://localhost:4000';
const INTERVAL_MS    = parseInt(process.env['INTERVAL_MS'] ?? '30000', 10);

function loadPolicy(): Policy {
  const raw      = readFileSync(POLICY_PATH, 'utf8');
  const expanded = raw.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
  return JSON.parse(expanded) as Policy;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const policy      = loadPolicy();
const deployments = loadDeployments(REPO_ROOT);

const circle = initiateDeveloperControlledWalletsClient({
  apiKey:         process.env['CIRCLE_API_KEY']!,
  entitySecret:   process.env['CIRCLE_ENTITY_SECRET']!,
});

const agentWallet   = deployments.wallets.customer;
const agentWalletId = agentWallet.circleWalletId;
const agentAddress  = agentWallet.address as `0x${string}`;
const usdcAddress   = process.env['USDC_ADDRESS']!;

const runner = new InsuranceRunner(
  policy,
  AGGREGATOR_URL,
  agentWalletId,
  agentAddress,
  usdcAddress,
  deployments.arcChainId,
  circle,
);

runner.on('event', (e) => {
  if (e.type === 'insurance.snapshot') {
    const val = e.latestValue !== null ? e.latestValue.toFixed(2) : '--';
    console.log(`[${new Date().toISOString()}] ${e.policyId} | ${e.status} | latest=${val} | balance=${e.premiumBalance}`);
  } else if (e.type === 'insurance.paid') {
    console.log(`[${new Date().toISOString()}] PAYOUT EXECUTED | tx=${e.txHash} | attestations=${e.attestationIds.join(',')}`);
  }
});

// Forward events to dashboard-backend if configured
const DASHBOARD_BACKEND_URL = process.env['DASHBOARD_BACKEND_URL'];
if (DASHBOARD_BACKEND_URL) {
  const { default: axios } = await import('axios');
  runner.on('event', (e) => {
    axios.post(`${DASHBOARD_BACKEND_URL}/events`, e).catch((err: unknown) => {
      console.error('[InsuranceRunner] dashboard POST failed:', err);
    });
  });
}

console.log(`\n✓ Insurance agent starting`);
console.log(`  Policy:      ${policy.policyId}`);
console.log(`  Data type:   ${policy.dataType}`);
console.log(`  Location:    ${policy.coverageLocation.lat}, ${policy.coverageLocation.lon}`);
console.log(`  Condition:   value ${policy.breachCondition.op} ${policy.breachCondition.threshold} for ${policy.breachCondition.consecutiveReadings} consecutive readings`);
console.log(`  Coverage:    ${parseInt(policy.coverageAmountUSDC) / 1e6} USDC`);
console.log(`  Aggregator:  ${AGGREGATOR_URL}`);
console.log(`  Interval:    ${INTERVAL_MS / 1000}s\n`);

runner.start(INTERVAL_MS);

// Graceful shutdown
process.on('SIGINT',  () => { runner.stop(); process.exit(0); });
process.on('SIGTERM', () => { runner.stop(); process.exit(0); });
