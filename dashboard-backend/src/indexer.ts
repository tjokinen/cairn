/**
 * Subscribes to Arc testnet contract events and pushes them onto the bus.
 * Uses ethers.js JsonRpcProvider with polling (Arc may not support WebSocket subscriptions).
 */
import { ethers } from 'ethers';
import type { Deployments } from '@cairn/common';
import { bus } from './bus.js';

// ── ABI fragments ─────────────────────────────────────────────────────────────

const REGISTRY_ABI = [
  'event SensorRegistered(uint256 indexed sensorId, address indexed wallet, string endpointUrl, bytes32[] dataTypes, int256 lat, int256 lon, uint256 ratePerQuery)',
  'event SensorDeactivated(uint256 indexed sensorId)',
  'event ReputationUpdated(uint256 indexed sensorId, uint256 newReputation, int256 delta)',
  'event Slashed(uint256 indexed sensorId, uint256 amount, uint256 remainingStake, bool autoDeactivated)',
];

const AGGREGATOR_ABI = [
  'event OperatorPaid(address indexed customer, uint256 indexed sensorId, address sensorWallet, uint256 amount, bytes32 indexed queryId)',
  'event ProtocolFeeCollected(address indexed customer, uint256 amount, bytes32 indexed queryId)',
];

const ATTESTATION_ABI = [
  'event AttestationPosted(bytes32 indexed attestationId, bytes32 indexed dataType, int256 lat, int256 lon, uint256 timestamp, uint256 confidenceBps)',
];

const DATATYPE_ABI = [
  'event DataTypeRegistered(bytes32 indexed id, string unit, int256 minValue, int256 maxValue, uint256 expectedVariance)',
];

// ── Indexer ───────────────────────────────────────────────────────────────────

export class Indexer {
  private provider: ethers.JsonRpcProvider;
  private registry:    ethers.Contract;
  private aggregator:  ethers.Contract;
  private attestation: ethers.Contract;
  private datatype:    ethers.Contract;
  private pollTimer:   ReturnType<typeof setInterval> | null = null;
  private lastBlock = 0;

  constructor(private deployments: Deployments) {
    this.provider    = new ethers.JsonRpcProvider(deployments.arcRpc, deployments.arcChainId);
    this.registry    = new ethers.Contract(deployments.contracts.sensorRegistry,   REGISTRY_ABI,    this.provider);
    this.aggregator  = new ethers.Contract(deployments.contracts.cairnAggregator,  AGGREGATOR_ABI,  this.provider);
    this.attestation = new ethers.Contract(deployments.contracts.cairnAttestation, ATTESTATION_ABI, this.provider);
    this.datatype    = new ethers.Contract(deployments.contracts.dataTypeRegistry, DATATYPE_ABI,    this.provider);
  }

  async start(): Promise<void> {
    const latest = await this.provider.getBlockNumber();

    // ── Backfill DataTypeRegistered (Arc caps eth_getLogs at 10,000 blocks) ─
    try {
      const fromBlock = Math.max(0, latest - 9000);
      const logs      = await this.datatype.queryFilter(this.datatype.filters['DataTypeRegistered'](), fromBlock, latest);
      for (const log of logs) {
        const decoded = this.datatype.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!decoded) continue;
        bus.publish({
          type: 'chain.datatype_registered',
          id:   ethers.decodeBytes32String(decoded.args[0] as string),
          unit: decoded.args[1] as string,
        });
      }
    } catch (err) {
      console.warn('[Indexer] DataTypeRegistered backfill failed:', err);
    }

    // Arc does not support stateful filters (eth_newFilter / eth_getFilterChanges).
    // Poll with queryFilter on a timer instead.
    this.lastBlock = latest;
    this.pollTimer = setInterval(() => void this.pollEvents(), 5_000);

    console.log('[Indexer] Started (getLogs polling, lastBlock=' + latest + ')');
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async pollEvents(): Promise<void> {
    try {
      const current = await this.provider.getBlockNumber();
      if (current <= this.lastBlock) return;

      const from = this.lastBlock + 1;
      const to   = Math.min(current, from + 9_000);

      const [regLogs, deactLogs, repLogs, slashLogs, opPaidLogs, feeLogs, attLogs, dtLogs] = await Promise.all([
        this.registry.queryFilter(this.registry.filters['SensorRegistered'](),   from, to),
        this.registry.queryFilter(this.registry.filters['SensorDeactivated'](),  from, to),
        this.registry.queryFilter(this.registry.filters['ReputationUpdated'](),  from, to),
        this.registry.queryFilter(this.registry.filters['Slashed'](),            from, to),
        this.aggregator.queryFilter(this.aggregator.filters['OperatorPaid'](),          from, to),
        this.aggregator.queryFilter(this.aggregator.filters['ProtocolFeeCollected'](),  from, to),
        this.attestation.queryFilter(this.attestation.filters['AttestationPosted'](),   from, to),
        this.datatype.queryFilter(this.datatype.filters['DataTypeRegistered'](),        from, to),
      ]);

      for (const log of regLogs) {
        const d = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (!d) continue;
        bus.publish({ type: 'chain.sensor_registered', sensorId: Number(d.args[0]), wallet: d.args[1] as string, endpointUrl: d.args[2] as string, dataTypes: (d.args[3] as string[]).map((x) => ethers.decodeBytes32String(x)), lat: Number(d.args[4]) / 1e6, lon: Number(d.args[5]) / 1e6, ratePerQuery: (d.args[6] as bigint).toString() });
      }
      for (const log of deactLogs) {
        const d = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.sensor_deactivated', sensorId: Number(d.args[0]) });
      }
      for (const log of repLogs) {
        const d = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.reputation_updated', sensorId: Number(d.args[0]), newReputation: (d.args[1] as bigint).toString(), delta: (d.args[2] as bigint).toString() });
      }
      for (const log of slashLogs) {
        const d = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.slashed', sensorId: Number(d.args[0]), amount: (d.args[1] as bigint).toString(), remainingStake: (d.args[2] as bigint).toString(), autoDeactivated: d.args[3] as boolean });
      }
      for (const log of opPaidLogs) {
        const d = this.aggregator.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.operator_paid', customer: d.args[0] as string, sensorId: Number(d.args[1]), sensorWallet: d.args[2] as string, amount: (d.args[3] as bigint).toString(), queryId: d.args[4] as string });
      }
      for (const log of feeLogs) {
        const d = this.aggregator.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.protocol_fee', customer: d.args[0] as string, amount: (d.args[1] as bigint).toString(), queryId: d.args[2] as string });
      }
      for (const log of attLogs) {
        const d = this.attestation.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.attestation_posted', attestationId: d.args[0] as string, dataType: ethers.decodeBytes32String(d.args[1] as string), lat: Number(d.args[2]) / 1e6, lon: Number(d.args[3]) / 1e6, timestamp: Number(d.args[4]), confidenceBps: Number(d.args[5]) });
      }
      for (const log of dtLogs) {
        const d = this.datatype.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (d) bus.publish({ type: 'chain.datatype_registered', id: ethers.decodeBytes32String(d.args[0] as string), unit: d.args[1] as string });
      }

      this.lastBlock = to;
    } catch (err) {
      console.warn('[Indexer] pollEvents failed:', (err as Error).message);
    }
  }
}
