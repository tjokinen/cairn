/**
 * On-chain interactions for the aggregator.
 *
 * USDC movements (fee forwarding, x402 settlement) go through Circle's
 * Developer-Controlled Wallets SDK — this is the Circle Nanopayments demo path.
 *
 * Registry / aggregator / attestation calls use ethers.js with the deployer
 * EOA (DEPLOYER_PRIVATE_KEY). Circle's SDK doesn't reliably encode int256
 * parameters with negative values, which breaks updateReputation.
 */
import { ethers, NonceManager } from 'ethers';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import type { Deployments, DataTypeMetadata } from '@cairn/common';

// ── ABI fragments ─────────────────────────────────────────────────────────────
const USDC_TRANSFER_SIG = 'transfer(address,uint256)';
const USDC_TWA_SIG      = 'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)';

const REGISTRY_WRITE_ABI = [
  'function updateReputation(uint256 sensorId, int256 delta) external',
  'function incrementQueryCount(uint256 sensorId) external',
];
const REGISTRY_READ_ABI = [
  'function sensorCount() view returns (uint256)',
  'function getSensor(uint256 sensorId) view returns (tuple(address wallet, string endpointUrl, bytes32[] dataTypes, int256 lat, int256 lon, uint256 ratePerQuery, uint256 reputation, bool active, uint256 stakeAmount, uint256 queryCount))',
  'event SensorRegistered(uint256 indexed sensorId, address indexed wallet, string endpointUrl, bytes32[] dataTypes, int256 lat, int256 lon, uint256 ratePerQuery)',
  'event SensorDeactivated(uint256 indexed sensorId)',
  'event ReputationUpdated(uint256 indexed sensorId, uint256 newReputation, int256 delta)',
  'event Slashed(uint256 indexed sensorId, uint256 amount, uint256 remainingStake, bool autoDeactivated)',
];
const AGGREGATOR_WRITE_ABI = [
  'function recordQuery(address customer, uint256[] calldata sensorIds, address[] calldata sensorWallets, uint256[] calldata operatorAmounts, uint256 protocolFeeAmount, bytes32 queryId) external',
];
const ATTESTATION_WRITE_ABI = [
  'function postAttestation((bytes32,int256,int256,uint256,uint256[],uint256[],int256,uint256,bytes32)) external',
  'event AttestationPosted(bytes32 indexed attestationId, bytes32 indexed dataType, int256 lat, int256 lon, uint256 timestamp, uint256 confidenceBps)',
];
const DATATYPE_ABI = [
  'function getType(bytes32 id) view returns (tuple(string unit, int256 minValue, int256 maxValue, uint256 expectedVariance, bool exists))',
];

export interface AttestationParams {
  dataType:             string;
  lat:                  number;
  lon:                  number;
  timestamp:            number;
  contributingSensors:  number[];
  excludedSensors:      number[];
  verifiedValue:        number;
  confidenceBps:        number;
  payloadHash:          string;
}

export class ChainClient {
  readonly circle: ReturnType<typeof initiateDeveloperControlledWalletsClient>;
  readonly provider: ethers.JsonRpcProvider;
  readonly registryContract: ethers.Contract;

  private signer: NonceManager;
  private registryWriter: ethers.Contract;
  private aggregatorWriter: ethers.Contract;
  private attestationWriter: ethers.Contract;
  private dataTypeContract: ethers.Contract;
  readonly usdcAddress: string;

  constructor(
    private deployments: Deployments,
    private aggregatorWalletId: string,
  ) {
    this.circle = initiateDeveloperControlledWalletsClient({
      apiKey:       requireEnv('CIRCLE_API_KEY'),
      entitySecret: requireEnv('CIRCLE_ENTITY_SECRET'),
    });
    this.provider = new ethers.JsonRpcProvider(deployments.arcRpc, deployments.arcChainId);
    this.usdcAddress = requireEnv('USDC_ADDRESS');

    // Deployer EOA — used for all registry/aggregator/attestation writes.
    // NonceManager tracks pending nonces so concurrent sends don't collide.
    this.signer = new NonceManager(
      new ethers.Wallet(requireEnv('DEPLOYER_PRIVATE_KEY'), this.provider),
    );

    // Read-only registry (no signer needed)
    this.registryContract = new ethers.Contract(
      deployments.contracts.sensorRegistry,
      [...REGISTRY_READ_ABI, ...REGISTRY_WRITE_ABI],
      this.provider,
    );

    // Write contracts connected to deployer signer
    this.registryWriter = new ethers.Contract(
      deployments.contracts.sensorRegistry,
      REGISTRY_WRITE_ABI,
      this.signer,
    );
    this.aggregatorWriter = new ethers.Contract(
      deployments.contracts.cairnAggregator,
      AGGREGATOR_WRITE_ABI,
      this.signer,
    );
    this.attestationWriter = new ethers.Contract(
      deployments.contracts.cairnAttestation,
      ATTESTATION_WRITE_ABI,
      this.signer,
    );
    this.dataTypeContract = new ethers.Contract(
      deployments.contracts.dataTypeRegistry,
      DATATYPE_ABI,
      this.provider,
    );
  }

  // ── USDC — Circle Nanopayments path ──────────────────────────────────────────

  async transferUsdc(toAddress: string, amount: number): Promise<string> {
    const res = await this.circle.createContractExecutionTransaction({
      walletId:             this.aggregatorWalletId,
      contractAddress:      this.usdcAddress,
      abiFunctionSignature: USDC_TRANSFER_SIG,
      abiParameters:        [toAddress, amount.toString()],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    const txId = res.data?.id;
    if (!txId) throw new Error('transferUsdc: no txId');
    const tx = await this.waitForCircleTx(txId, `USDC.transfer → ${toAddress}`);
    return tx.txHash!;
  }

  async settleTransferWithAuth(
    from: string, to: string, value: string,
    validAfter: string, validBefore: string,
    nonce: string, signature: string,
  ): Promise<string> {
    const res = await this.circle.createContractExecutionTransaction({
      walletId:             this.aggregatorWalletId,
      contractAddress:      this.usdcAddress,
      abiFunctionSignature: USDC_TWA_SIG,
      abiParameters:        [from, to, value, validAfter, validBefore, nonce, signature],
      fee: { type: 'level', config: { feeLevel: 'HIGH' } },
    });
    const txId = res.data?.id;
    if (!txId) throw new Error('settleTransferWithAuth: no txId');
    const tx = await this.waitForCircleTx(txId, 'settle customer payment');
    return tx.txHash!;
  }

  // ── Registry — ethers.js path ─────────────────────────────────────────────────

  async updateReputation(sensorId: number, delta: bigint): Promise<void> {
    const tx = await this.registryWriter.updateReputation(sensorId, delta);
    await tx.wait();
  }

  async incrementQueryCount(sensorId: number): Promise<void> {
    const tx = await this.registryWriter.incrementQueryCount(sensorId);
    await tx.wait();
  }

  // ── CairnAggregator — ethers.js path ─────────────────────────────────────────

  async recordQuery(
    customer: string,
    sensorIds: number[],
    sensorWallets: string[],
    amounts: number[],
    protocolFee: number,
    queryId: string,
  ): Promise<void> {
    const tx = await this.aggregatorWriter.recordQuery(
      customer, sensorIds, sensorWallets, amounts, protocolFee, queryId,
    );
    await tx.wait();
  }

  // ── CairnAttestation — ethers.js path ────────────────────────────────────────

  async postAttestation(p: AttestationParams): Promise<string> {
    const dataTypeBytes32 = ethers.encodeBytes32String(p.dataType);
    const lat   = Math.round(p.lat * 1e6);
    const lon   = Math.round(p.lon * 1e6);
    const value = Math.round(p.verifiedValue * 1_000_000);

    const tx = await this.attestationWriter.postAttestation([
      dataTypeBytes32,
      lat,
      lon,
      p.timestamp,
      p.contributingSensors,
      p.excludedSensors,
      value,
      p.confidenceBps,
      p.payloadHash,
    ]);
    const receipt = await tx.wait();

    const iface = new ethers.Interface(ATTESTATION_WRITE_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'AttestationPosted') return parsed.args.attestationId as string;
      } catch { /* skip */ }
    }
    throw new Error('AttestationPosted event not found');
  }

  // ── DataTypeRegistry ──────────────────────────────────────────────────────────

  async getDataTypeMetadata(dataType: string): Promise<DataTypeMetadata> {
    const id = ethers.encodeBytes32String(dataType);
    const t  = await this.dataTypeContract.getType(id);
    return {
      id:               dataType,
      unit:             t.unit as string,
      minValue:         Number(t.minValue) / 1e6,
      maxValue:         Number(t.maxValue) / 1e6,
      expectedVariance: Number(t.expectedVariance) / 1e6,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  async waitForCircleTx(txId: string, label: string): Promise<{ txHash?: string }> {
    const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DENIED']);
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const res   = await this.circle.getTransaction({ id: txId });
      const tx    = res.data?.transaction;
      const state = tx?.state;
      if (!state) continue;
      if (state === 'COMPLETE') return tx as { txHash?: string };
      if (TERMINAL.has(state)) throw new Error(`Tx ${txId} ended in state ${state} (${label})`);
    }
    throw new Error(`Tx ${txId} timed out (${label})`);
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
