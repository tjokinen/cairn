import { ethers } from 'ethers';
import type { SensorInfo } from './types.js';
import type { Deployments } from '@cairn/common';

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const REGISTRY_ABI = [
  'function sensorCount() view returns (uint256)',
  'function getSensor(uint256 sensorId) view returns (tuple(address wallet, string endpointUrl, bytes32[] dataTypes, int256 lat, int256 lon, uint256 ratePerQuery, uint256 reputation, bool active, uint256 stakeAmount, uint256 queryCount))',
  'event SensorRegistered(uint256 indexed sensorId, address indexed wallet, string endpointUrl, bytes32[] dataTypes, int256 lat, int256 lon, uint256 ratePerQuery)',
  'event SensorDeactivated(uint256 indexed sensorId)',
  'event ReputationUpdated(uint256 indexed sensorId, uint256 newReputation, int256 delta)',
];

export class DiscoveryService {
  private sensors = new Map<number, SensorInfo>();
  private provider: ethers.JsonRpcProvider;
  private registry: ethers.Contract;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastBlock = 0;

  constructor(private deployments: Deployments) {
    this.provider = new ethers.JsonRpcProvider(deployments.arcRpc, deployments.arcChainId);
    this.registry = new ethers.Contract(
      deployments.contracts.sensorRegistry,
      REGISTRY_ABI,
      this.provider,
    );
  }

  async load(): Promise<void> {
    const count = Number(await this.registry.sensorCount());
    await Promise.all(Array.from({ length: count }, (_, i) => this.loadSensor(i + 1)));

    // Arc doesn't support stateful filters (eth_newFilter), so we poll with queryFilter.
    this.lastBlock = await this.provider.getBlockNumber();
    this.pollTimer = setInterval(() => void this.pollEvents(), 5_000);

    console.log(`  Discovery: loaded ${this.sensors.size} sensors`);
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

      const [registered, deactivated, reputation] = await Promise.all([
        this.registry.queryFilter(this.registry.filters['SensorRegistered'](), from, to),
        this.registry.queryFilter(this.registry.filters['SensorDeactivated'](), from, to),
        this.registry.queryFilter(this.registry.filters['ReputationUpdated'](), from, to),
      ]);

      for (const log of registered) {
        const decoded = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (decoded) void this.loadSensor(Number(decoded.args[0] as bigint));
      }
      for (const log of deactivated) {
        const decoded = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (decoded) {
          const s = this.sensors.get(Number(decoded.args[0] as bigint));
          if (s) s.active = false;
        }
      }
      for (const log of reputation) {
        const decoded = this.registry.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (decoded) {
          const s = this.sensors.get(Number(decoded.args[0] as bigint));
          if (s) s.reputation = decoded.args[1] as bigint;
        }
      }

      this.lastBlock = to;
    } catch (err) {
      console.warn('[Discovery] pollEvents failed:', (err as Error).message);
    }
  }

  private async loadSensor(id: number): Promise<void> {
    try {
      const s = await this.registry.getSensor(id);
      const dataTypes = (s.dataTypes as string[]).map((b32) => ethers.decodeBytes32String(b32));
      this.sensors.set(id, {
        sensorId:     id,
        wallet:       s.wallet as string,
        endpointUrl:  s.endpointUrl as string,
        dataTypes,
        lat:          Number(s.lat) / 1e6,
        lon:          Number(s.lon) / 1e6,
        ratePerQuery: Number(s.ratePerQuery),
        reputation:   s.reputation as bigint,
        active:       s.active as boolean,
      });
    } catch { /* ignore */ }
  }

  findSensors(dataType: string, lat: number, lon: number, radiusKm: number): SensorInfo[] {
    return Array.from(this.sensors.values()).filter((s) =>
      s.active &&
      s.dataTypes.includes(dataType) &&
      haversineKm(lat, lon, s.lat, s.lon) <= radiusKm,
    );
  }

  selectTopSensors(sensors: SensorInfo[], quorum: number): SensorInfo[] {
    if (sensors.length === 0) return [];
    const maxRate = Math.max(...sensors.map((s) => s.ratePerQuery));
    return sensors
      .map((s) => {
        const rateScore = maxRate > 0 ? 1 - s.ratePerQuery / maxRate : 1;
        const repScore  = Number(s.reputation) / 1e18;
        return { sensor: s, score: repScore * 0.6 + rateScore * 0.4 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, quorum)
      .map((e) => e.sensor);
  }
}
