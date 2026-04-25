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

    this.registry.on('SensorRegistered', (id: bigint) => { void this.loadSensor(Number(id)); });
    this.registry.on('SensorDeactivated', (id: bigint) => {
      const s = this.sensors.get(Number(id));
      if (s) s.active = false;
    });
    this.registry.on('ReputationUpdated', (id: bigint, newRep: bigint) => {
      const s = this.sensors.get(Number(id));
      if (s) s.reputation = newRep;
    });

    console.log(`  Discovery: loaded ${this.sensors.size} sensors`);
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
