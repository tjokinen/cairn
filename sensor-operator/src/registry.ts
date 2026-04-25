/**
 * On-chain interactions for sensor registration.
 * Uses the Circle Developer-Controlled Wallets SDK for transaction execution
 * and ethers.js for RPC reads and event parsing.
 */
import { ethers } from 'ethers';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { Deployments } from '@cairn/common';
import type { OperatorConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ABI fragments — only what we need
const USDC_APPROVE_SIG    = 'approve(address,uint256)';
const REGISTRY_REGISTER_SIG = 'register(string,bytes32[],int256,int256,uint256)';

const SENSOR_REGISTERED_ABI = [
  'event SensorRegistered(uint256 indexed sensorId, address indexed wallet, string endpointUrl, bytes32[] dataTypes, int256 lat, int256 lon, uint256 ratePerQuery)',
];

const STAKE_REQUIRED = 10_000_000n; // 10 USDC

export class RegistryClient {
  private circle: ReturnType<typeof initiateDeveloperControlledWalletsClient>;
  private provider: ethers.JsonRpcProvider;
  private deployments: Deployments;
  private iface: ethers.Interface;

  constructor(deployments: Deployments) {
    this.deployments = deployments;
    this.circle = initiateDeveloperControlledWalletsClient({
      apiKey:        requireEnv('CIRCLE_API_KEY'),
      entitySecret:  requireEnv('CIRCLE_ENTITY_SECRET'),
    });
    this.provider = new ethers.JsonRpcProvider(
      deployments.arcRpc,
      deployments.arcChainId,
    );
    this.iface = new ethers.Interface(SENSOR_REGISTERED_ABI);
  }

  async getWalletAddress(walletId: string): Promise<string> {
    const res = await this.circle.getWallet({ id: walletId });
    const addr = res.data?.wallet?.address;
    if (!addr) throw new Error(`Could not get address for wallet ${walletId}`);
    return addr;
  }

  async getAllowance(ownerAddress: string): Promise<bigint> {
    const usdcAbi = ['function allowance(address,address) view returns (uint256)'];
    const usdc = new ethers.Contract(
      requireEnv('USDC_ADDRESS'),
      usdcAbi,
      this.provider,
    );
    return await usdc.allowance(ownerAddress, this.deployments.contracts.sensorRegistry) as bigint;
  }

  async ensureApproval(walletId: string): Promise<void> {
    const address = await this.getWalletAddress(walletId);
    const allowance = await this.getAllowance(address);
    if (allowance >= STAKE_REQUIRED) return;

    console.log(`  Approving ${STAKE_REQUIRED} USDC to SensorRegistry...`);
    const res = await this.circle.createContractExecutionTransaction({
      walletId,
      contractAddress: requireEnv('USDC_ADDRESS'),
      abiFunctionSignature: USDC_APPROVE_SIG,
      abiParameters: [
        this.deployments.contracts.sensorRegistry,
        STAKE_REQUIRED.toString(),
      ],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    const txId = res.data?.id;
    if (!txId) throw new Error('Approve transaction not created');
    await this.waitForTx(txId, 'approve USDC');
  }

  async register(walletId: string, config: OperatorConfig): Promise<number> {
    // Encode dataTypes as bytes32 array
    const dataTypeBytes32 = config.dataTypes.map((dt) =>
      ethers.encodeBytes32String(dt),
    );

    const lat = Math.round(config.location.lat * 1e6);
    const lon = Math.round(config.location.lon * 1e6);
    const endpointUrl = `http://localhost:${config.port}`;

    console.log(`  Calling SensorRegistry.register() for ${config.name}...`);
    const res = await this.circle.createContractExecutionTransaction({
      walletId,
      contractAddress: this.deployments.contracts.sensorRegistry,
      abiFunctionSignature: REGISTRY_REGISTER_SIG,
      abiParameters: [
        endpointUrl,
        dataTypeBytes32,
        lat.toString(),
        lon.toString(),
        config.ratePerQuery.toString(),
      ],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });

    const txId = res.data?.id;
    if (!txId) throw new Error('Register transaction not created');
    const tx = await this.waitForTx(txId, 'register sensor');

    return this.parseSensorId(tx.txHash!);
  }

  private async parseSensorId(txHash: string): Promise<number> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt) throw new Error(`No receipt for tx ${txHash}`);

    for (const log of receipt.logs) {
      try {
        const parsed = this.iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'SensorRegistered') {
          return Number(parsed.args.sensorId);
        }
      } catch {
        // skip non-matching logs
      }
    }
    throw new Error(`SensorRegistered event not found in tx ${txHash}`);
  }

  private async waitForTx(txId: string, label: string): Promise<{ txHash?: string }> {
    const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']);
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(2000);
      const res = await this.circle.getTransaction({ id: txId });
      const tx  = res.data?.transaction;
      const state = tx?.state;

      if (!state) continue;
      if (state === 'COMPLETE') {
        console.log(`  ✓ ${label} confirmed (${tx.txHash})`);
        return tx as { txHash?: string };
      }
      if (TERMINAL.has(state)) {
        throw new Error(`Transaction ${txId} ended in state ${state} (${label})`);
      }
    }
    throw new Error(`Transaction ${txId} timed out after 120s (${label})`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
