/**
 * Calls setAggregatorService(aggregatorWallet) on SensorRegistry,
 * CairnAggregator, and CairnAttestation.
 *
 * Run once after bootstrap (or after redeployment):
 *   npm run setup:aggregator
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { loadDeployments } from '@cairn/common';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const SET_SIG = 'setAggregatorService(address)';
const ABI = [
  `function ${SET_SIG}`,
  'function aggregatorService() view returns (address)',
];

async function main() {
  const deployments = loadDeployments(REPO_ROOT);
  const provider = new ethers.JsonRpcProvider(deployments.arcRpc, deployments.arcChainId);

  const deployerKey = process.env['DEPLOYER_PRIVATE_KEY'];
  if (!deployerKey) throw new Error('DEPLOYER_PRIVATE_KEY not set');
  const deployer = new ethers.Wallet(deployerKey, provider);

  // aggregatorService = deployer EOA (ethers.js path for registry/aggregator/attestation writes).
  // Circle SDK is used only for USDC movements (transferUsdc, settleTransferWithAuth).
  const aggregatorAddress = deployer.address;
  console.log(`\nSetting aggregatorService = ${aggregatorAddress} (deployer EOA)`);
  console.log(`Deployer:                  ${deployer.address}\n`);

  const contracts: { name: string; address: string }[] = [
    { name: 'SensorRegistry',   address: deployments.contracts.sensorRegistry },
    { name: 'CairnAggregator',  address: deployments.contracts.cairnAggregator },
    { name: 'CairnAttestation', address: deployments.contracts.cairnAttestation },
  ];

  for (const { name, address } of contracts) {
    const contract = new ethers.Contract(address, ABI, deployer);
    const current = await contract.aggregatorService() as string;
    if (current.toLowerCase() === aggregatorAddress.toLowerCase()) {
      console.log(`  ${name}: already set ✓`);
      continue;
    }
    process.stdout.write(`  ${name}: setting... `);
    const tx = await contract.setAggregatorService(aggregatorAddress);
    await tx.wait();
    console.log(`done (tx: ${tx.hash})`);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
