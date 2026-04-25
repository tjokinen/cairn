/**
 * Cairn bootstrap script.
 * Creates 9 Circle Wallets, funds them from the Arc testnet faucet,
 * deploys all four Cairn contracts, and writes deployments.json.
 *
 * Prerequisites:
 *   - .env with CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_WALLET_SET_ID
 *   - contracts built: run `cd contracts && forge build` first
 *
 * Usage: npm run bootstrap
 */

import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ethers } from 'ethers';
import {
  initiateDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── Helpers (defined early — used at module level below) ──────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Config ──────────────────────────────────────────────────────────────────

const ARC_RPC_URL = process.env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
const ARC_CHAIN_ID = parseInt(process.env.ARC_CHAIN_ID ?? '5042002', 10);

const CIRCLE_API_KEY = requireEnv('CIRCLE_API_KEY');
const CIRCLE_ENTITY_SECRET = requireEnv('CIRCLE_ENTITY_SECRET');
const CIRCLE_WALLET_SET_ID = requireEnv('CIRCLE_WALLET_SET_ID');

// ── Wallet names ─────────────────────────────────────────────────────────────

const WALLET_NAMES = [
  'treasury',
  'aggregator',
  'policyholder',
  'operator1',
  'operator2',
  'operator3',
  'operator4',
  'operator5',
  'customer',
] as const;

type WalletName = typeof WALLET_NAMES[number];

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Cairn Bootstrap ===\n');

  // 1. Create Circle Wallets
  console.log('Step 1: Creating Circle Wallets...');
  const wallets = await createWallets();
  console.log(`  Created ${Object.keys(wallets).length} wallets\n`);

  // Write partial deployments.json immediately so a re-run reuses these wallets
  // even if the next steps fail (e.g. unfunded wallets, failed deployment).
  const outputPath = resolve(REPO_ROOT, 'deployments.json');
  const partial = { arcRpc: ARC_RPC_URL, arcChainId: ARC_CHAIN_ID, contracts: null, wallets };
  writeFileSync(outputPath, JSON.stringify(partial, null, 2));
  console.log(`  (Wallet data saved to deployments.json)\n`);

  // 2. Fund wallets from Arc faucet
  console.log('Step 2: Funding wallets from Arc testnet faucet...');
  await fundWallets(wallets);
  console.log('  Funding requests submitted\n');

  // 3. Deploy contracts
  console.log('Step 3: Deploying contracts...');
  const contracts = await deployContracts(wallets.treasury.address);
  console.log('  All contracts deployed\n');

  // 4. Write complete deployments.json
  const deployments = {
    arcRpc: ARC_RPC_URL,
    arcChainId: ARC_CHAIN_ID,
    contracts,
    wallets,
  };

  writeFileSync(outputPath, JSON.stringify(deployments, null, 2));
  console.log(`Step 4: deployments.json written to ${outputPath}\n`);

  // 5. Set aggregatorService = deployer EOA on all three contracts.
  //    Registry/aggregator/attestation writes use ethers.js with DEPLOYER_PRIVATE_KEY
  //    (Circle SDK is used only for USDC movements).
  console.log('Step 5: Setting aggregatorService on contracts...');
  const deployerForStep5 = new ethers.Wallet(requireEnv('DEPLOYER_PRIVATE_KEY'));
  await setAggregatorService(contracts, deployerForStep5.address);
  console.log('  aggregatorService set on all contracts\n');

  console.log('=== Bootstrap complete ===');
  console.log('Contract addresses:');
  for (const [name, addr] of Object.entries(contracts)) {
    console.log(`  ${name}: ${addr}`);
  }
}

// ── Circle Wallets ────────────────────────────────────────────────────────────

async function createWallets(): Promise<Record<WalletName, { address: string; circleWalletId: string }>> {
  // If deployments.json already exists and has all wallets, reuse them — don't create new ones.
  const deploymentsPath = resolve(REPO_ROOT, 'deployments.json');
  if (existsSync(deploymentsPath)) {
    const existing = JSON.parse(readFileSync(deploymentsPath, 'utf8'));
    const existingWallets = existing?.wallets as Record<string, { address: string; circleWalletId: string }> | undefined;
    if (existingWallets && WALLET_NAMES.every(n => existingWallets[n]?.circleWalletId)) {
      console.log('  Found existing wallets in deployments.json — reusing them.');
      for (const name of WALLET_NAMES) {
        console.log(`  ${name.padEnd(14)} ${existingWallets[name].address}  (reused)`);
      }
      return existingWallets as Record<WalletName, { address: string; circleWalletId: string }>;
    }
  }

  const client = initiateDeveloperControlledWalletsClient({
    apiKey: CIRCLE_API_KEY,
    entitySecret: CIRCLE_ENTITY_SECRET,
  });

  const result: Partial<Record<WalletName, { address: string; circleWalletId: string }>> = {};

  for (const name of WALLET_NAMES) {
    process.stdout.write(`  Creating wallet: ${name}...`);

    const response = await client.createWallets({
      blockchains: ['ARC-TESTNET'],
      count: 1,
      walletSetId: CIRCLE_WALLET_SET_ID,
      metadata: [{ name: `cairn-${name}`, refId: `cairn-${name}` }],
    });

    const wallet = response.data?.wallets?.[0];
    if (!wallet?.id || !wallet?.address) {
      throw new Error(`Failed to create wallet for ${name}: ${JSON.stringify(response)}`);
    }

    result[name] = { address: wallet.address, circleWalletId: wallet.id };
    console.log(` ${wallet.address}`);

    // Brief pause to avoid rate limiting
    await sleep(300);
  }

  return result as Record<WalletName, { address: string; circleWalletId: string }>;
}

// ── Manual funding prompt ─────────────────────────────────────────────────────

async function fundWallets(
  wallets: Record<WalletName, { address: string; circleWalletId: string }>
): Promise<void> {
  console.log('\n  Fund these addresses from the Arc testnet faucet (https://faucet.circle.com):');
  for (const [name, wallet] of Object.entries(wallets)) {
    console.log(`    ${name.padEnd(14)} ${wallet.address}`);
  }
  console.log('\n  The deployer wallet also needs to be funded (set in DEPLOYER_PRIVATE_KEY).');
  console.log('  Press Enter once all wallets are funded...');

  await new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });

  // Verify balances before proceeding
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, ARC_CHAIN_ID);
  let anyUnfunded = false;
  for (const [name, wallet] of Object.entries(wallets)) {
    const balance = await provider.getBalance(wallet.address);
    const usdc = parseFloat(ethers.formatEther(balance));
    const status = usdc > 0 ? '✓' : '✗ UNFUNDED';
    console.log(`  ${name.padEnd(14)} ${usdc.toFixed(4)} USDC  ${status}`);
    if (usdc === 0) anyUnfunded = true;
  }

  if (anyUnfunded) {
    throw new Error('Some wallets have zero balance. Fund them and re-run bootstrap.');
  }
}

// ── Contract deployment ───────────────────────────────────────────────────────

async function deployContracts(treasuryAddress: string): Promise<{
  dataTypeRegistry: string;
  sensorRegistry: string;
  cairnAggregator: string;
  cairnAttestation: string;
}> {
  const outDir = resolve(REPO_ROOT, 'contracts', 'out');
  if (!existsSync(outDir)) {
    throw new Error(
      'contracts/out/ not found. Run `cd contracts && forge build` before bootstrapping.'
    );
  }

  // We need a deployer wallet with funded native tokens.
  // Bootstrap uses the aggregator wallet as deployer since it is funded above.
  // The deployer private key must be set in .env (DEPLOYER_PRIVATE_KEY) or we
  // generate one and ask the user to fund it.
  const deployerKey = requireEnv('DEPLOYER_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, ARC_CHAIN_ID);
  const deployer = new ethers.Wallet(deployerKey, provider);

  console.log(`  Deployer: ${deployer.address}`);
  const balance = await provider.getBalance(deployer.address);
  console.log(`  Deployer balance: ${ethers.formatEther(balance)} USDC`);

  // 1. DataTypeRegistry
  const dataTypeRegistry = await deployContract(deployer, 'DataTypeRegistry', []);
  console.log(`  DataTypeRegistry: ${dataTypeRegistry}`);

  // 2. SensorRegistry
  // USDC on Arc has an ERC-20 interface at 0x3600...0000 (6 decimals) — used for stake transferFrom.
  const USDC_ADDRESS = process.env.USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000';
  const sensorRegistry = await deployContract(deployer, 'SensorRegistry', [
    treasuryAddress,
    USDC_ADDRESS,
  ]);
  console.log(`  SensorRegistry: ${sensorRegistry}`);

  // 3. CairnAggregator (depends on treasury; aggregatorService set post-deploy via setAggregatorService)
  const cairnAggregator = await deployContract(deployer, 'CairnAggregator', [treasuryAddress]);
  console.log(`  CairnAggregator: ${cairnAggregator}`);

  // 4. CairnAttestation (aggregatorService set post-deploy)
  const cairnAttestation = await deployContract(deployer, 'CairnAttestation', []);
  console.log(`  CairnAttestation: ${cairnAttestation}`);

  return { dataTypeRegistry, sensorRegistry, cairnAggregator, cairnAttestation };
}

async function deployContract(
  deployer: ethers.Wallet,
  contractName: string,
  constructorArgs: unknown[]
): Promise<string> {
  const artifactPath = resolve(
    REPO_ROOT,
    'contracts',
    'out',
    `${contractName}.sol`,
    `${contractName}.json`
  );

  if (!existsSync(artifactPath)) {
    throw new Error(`Artifact not found: ${artifactPath}. Run forge build.`);
  }

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const abi = artifact.abi;
  const bytecode = artifact.bytecode.object;

  const factory = new ethers.ContractFactory(abi, bytecode, deployer);
  const contract = await factory.deploy(...constructorArgs);
  await contract.waitForDeployment();

  return await contract.getAddress();
}

// ── setAggregatorService ──────────────────────────────────────────────────────

async function setAggregatorService(
  contracts: { sensorRegistry: string; cairnAggregator: string; cairnAttestation: string },
  aggregatorAddress: string,
): Promise<void> {
  const deployerKey = requireEnv('DEPLOYER_PRIVATE_KEY');
  const provider = new ethers.JsonRpcProvider(ARC_RPC_URL, ARC_CHAIN_ID);
  const deployer = new ethers.Wallet(deployerKey, provider);

  const abi = ['function setAggregatorService(address) external', 'function aggregatorService() view returns (address)'];
  const targets = [
    { name: 'SensorRegistry',   address: contracts.sensorRegistry },
    { name: 'CairnAggregator',  address: contracts.cairnAggregator },
    { name: 'CairnAttestation', address: contracts.cairnAttestation },
  ];
  for (const { name, address } of targets) {
    const c = new ethers.Contract(address, abi, deployer);
    const current = await c.aggregatorService() as string;
    if (current.toLowerCase() === aggregatorAddress.toLowerCase()) {
      console.log(`    ${name}: already set ✓`);
      continue;
    }
    process.stdout.write(`    ${name}: setting... `);
    const tx = await c.setAggregatorService(aggregatorAddress);
    await tx.wait();
    console.log(`done (${tx.hash})`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\nBootstrap failed:', err.message);
  process.exit(1);
});
