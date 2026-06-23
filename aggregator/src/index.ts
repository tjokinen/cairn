import 'dotenv/config';
import { loadDeployments } from '@cairn/common';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import { DiscoveryService } from './discovery.js';
import { ChainClient }      from './chain.js';
import { LocalFacilitatorClient } from './facilitator.js';
import { buildServer }      from './server.js';
import { ReadingCache }     from './cache.js';
import type { CacheEntry }  from './cache.js';
import { bus }              from './bus.js';

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

  // ── Reading cache + sensor payout settlement ──────────────────────────────
  // Aggregates per-sensor totals across all evicted entries and settles via
  // a single Circle USDC transfer per sensor wallet.
  const payoutCallback = async (entries: CacheEntry[]): Promise<void> => {
    const totals = new Map<string, { wallet: string; amount: number; sensorIds: Set<number>; hitCount: number }>();
    for (const entry of entries) {
      for (const sensor of entry.attribution) {
        const existing = totals.get(sensor.sensorWallet) ?? {
          wallet: sensor.sensorWallet, amount: 0, sensorIds: new Set<number>(), hitCount: 0,
        };
        existing.amount   += sensor.ratePerQuery * entry.hitCount;
        existing.hitCount += entry.hitCount;
        existing.sensorIds.add(sensor.sensorId);
        totals.set(sensor.sensorWallet, existing);
      }
    }

    for (const { wallet, amount, sensorIds, hitCount } of totals.values()) {
      if (amount <= 0) continue;
      const txHash = await chain.transferUsdc(wallet, amount);
      const sensorIdsArr = [...sensorIds];
      console.log(`[cache] paid ${(amount / 1e6).toFixed(6)} USDC to ${wallet} for ${hitCount} cache hits (sensorIds=${sensorIdsArr.join(',')}, tx=${txHash})`);
      for (const sensorId of sensorIdsArr) {
        bus.publish({ type: 'query.sensor_payment', sensorId, wallet, amount: amount / sensorIdsArr.length, txHash });
      }
    }
  };

  const cachePersistPath = resolve(REPO_ROOT, 'aggregator', 'state', 'reading-cache.json');
  const readingCache = new ReadingCache(payoutCallback, cachePersistPath);
  await readingCache.start();

  buildServer(deployments, discovery, chain, facilitator, readingCache, aggregatorWalletId, aggregatorAddress, aggregatorPort);
}

main().catch((err) => {
  console.error('Aggregator startup failed:', err);
  process.exit(1);
});
