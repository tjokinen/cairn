import 'dotenv/config';
import { loadDeployments } from '@cairn/common';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import { DiscoveryService } from './discovery.js';
import { ChainClient }      from './chain.js';
import { LocalFacilitatorClient } from './facilitator.js';
import { buildServer }      from './server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main() {
  const deployments = loadDeployments(REPO_ROOT);

  const aggregatorWalletId = requireEnv('AGGREGATOR_WALLET_ID');
  const aggregatorAddress  = deployments.wallets.aggregator.address as `0x${string}`;
  const aggregatorPort     = parseInt(process.env.AGGREGATOR_PORT ?? '4000', 10);

  console.log('\n=== Cairn Aggregator ===');
  console.log(`  Port:    ${aggregatorPort}`);
  console.log(`  Wallet:  ${aggregatorAddress}`);

  const chain       = new ChainClient(deployments, aggregatorWalletId);
  const facilitator = new LocalFacilitatorClient(chain, deployments.arcChainId, requireEnv('USDC_ADDRESS'));
  const discovery   = new DiscoveryService(deployments);

  await facilitator.init();
  await discovery.load();

  buildServer(deployments, discovery, chain, facilitator, aggregatorWalletId, aggregatorAddress, aggregatorPort);
}

main().catch((err) => {
  console.error('Aggregator startup failed:', err);
  process.exit(1);
});
