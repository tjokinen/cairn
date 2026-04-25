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

  constructor(private deployments: Deployments) {
    // Polling interval 2s — stays well within the 2s delivery SLA
    this.provider    = new ethers.JsonRpcProvider(deployments.arcRpc, deployments.arcChainId, { polling: true, pollingInterval: 2000 });
    this.registry    = new ethers.Contract(deployments.contracts.sensorRegistry,   REGISTRY_ABI,    this.provider);
    this.aggregator  = new ethers.Contract(deployments.contracts.cairnAggregator,  AGGREGATOR_ABI,  this.provider);
    this.attestation = new ethers.Contract(deployments.contracts.cairnAttestation, ATTESTATION_ABI, this.provider);
    this.datatype    = new ethers.Contract(deployments.contracts.dataTypeRegistry, DATATYPE_ABI,    this.provider);
  }

  async start(): Promise<void> {
    // ── SensorRegistry ──────────────────────────────────────────────────────
    this.registry.on('SensorRegistered', (sensorId, wallet, endpointUrl, dataTypes, lat, lon, ratePerQuery) => {
      bus.publish({
        type:        'chain.sensor_registered',
        sensorId:    Number(sensorId),
        wallet,
        endpointUrl,
        dataTypes:   (dataTypes as string[]).map((d) => ethers.decodeBytes32String(d)),
        lat:         Number(lat) / 1e6,
        lon:         Number(lon) / 1e6,
        ratePerQuery: ratePerQuery.toString(),
      });
    });

    this.registry.on('SensorDeactivated', (sensorId) => {
      bus.publish({ type: 'chain.sensor_deactivated', sensorId: Number(sensorId) });
    });

    this.registry.on('ReputationUpdated', (sensorId, newReputation, delta) => {
      bus.publish({
        type:          'chain.reputation_updated',
        sensorId:      Number(sensorId),
        newReputation: newReputation.toString(),
        delta:         delta.toString(),
      });
    });

    this.registry.on('Slashed', (sensorId, amount, remainingStake, autoDeactivated) => {
      bus.publish({
        type:             'chain.slashed',
        sensorId:         Number(sensorId),
        amount:           amount.toString(),
        remainingStake:   remainingStake.toString(),
        autoDeactivated,
      });
    });

    // ── CairnAggregator ─────────────────────────────────────────────────────
    this.aggregator.on('OperatorPaid', (customer, sensorId, sensorWallet, amount, queryId) => {
      bus.publish({
        type:        'chain.operator_paid',
        customer,
        sensorId:    Number(sensorId),
        sensorWallet,
        amount:      amount.toString(),
        queryId,
      });
    });

    this.aggregator.on('ProtocolFeeCollected', (customer, amount, queryId) => {
      bus.publish({
        type:     'chain.protocol_fee',
        customer,
        amount:   amount.toString(),
        queryId,
      });
    });

    // ── CairnAttestation ────────────────────────────────────────────────────
    this.attestation.on('AttestationPosted', (attestationId, dataType, lat, lon, timestamp, confidenceBps) => {
      bus.publish({
        type:          'chain.attestation_posted',
        attestationId,
        dataType:      ethers.decodeBytes32String(dataType),
        lat:           Number(lat) / 1e6,
        lon:           Number(lon) / 1e6,
        timestamp:     Number(timestamp),
        confidenceBps: Number(confidenceBps),
      });
    });

    // ── DataTypeRegistry (startup scan only, then live) ─────────────────────
    this.datatype.on('DataTypeRegistered', (id, unit) => {
      bus.publish({
        type: 'chain.datatype_registered',
        id:   ethers.decodeBytes32String(id),
        unit,
      });
    });

    // Backfill DataTypeRegistered events so frontend knows all types on load
    // Note: Arc limits log queries to 10,000 blocks, so we query from a recent block
    try {
      const filter    = this.datatype.filters['DataTypeRegistered']();
      const latest    = await this.provider.getBlockNumber();
      const fromBlock = Math.max(0, latest - 9000);
      const logs      = await this.datatype.queryFilter(filter, fromBlock, 'latest');
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

    console.log('[Indexer] Subscribed to all contract events');
  }

  stop(): void {
    this.registry.removeAllListeners();
    this.aggregator.removeAllListeners();
    this.attestation.removeAllListeners();
    this.datatype.removeAllListeners();
  }
}
