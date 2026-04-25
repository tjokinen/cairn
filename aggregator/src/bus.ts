import { EventEmitter } from 'events';
import https from 'https';
import http  from 'http';

export type BusEvent =
  | { type: 'query.received';           customer: string; params: Record<string, unknown>; selectedSensorIds: number[] }
  | { type: 'query.sensor_payment';     sensorId: number; wallet: string; amount: number; txHash: string }
  | { type: 'query.fee_forwarded';      amount: number; txHash: string }
  | { type: 'query.attestation_posted'; attestationId: string }
  | { type: 'query.reputation_updated'; sensorId: number; delta: string; bucket: 'accepted' | 'outlier' }
  | { type: 'query.slashed';            sensorId: number }
  | { type: 'query.completed';          response: Record<string, unknown> };

function postToDashboard(url: string, payload: BusEvent): void {
  const body = JSON.stringify(payload);
  const parsed = new URL(url);
  const mod    = parsed.protocol === 'https:' ? https : http;
  const req    = mod.request(parsed, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  });
  req.on('error', () => { /* fire-and-forget; dashboard missing is non-fatal */ });
  req.write(body);
  req.end();
}

class EventBus extends EventEmitter {
  private dashboardUrl: string | undefined = process.env['DASHBOARD_BACKEND_URL'];

  emit(event: 'cairn', payload: BusEvent): boolean {
    return super.emit('cairn', payload);
  }
  on(event: 'cairn', listener: (payload: BusEvent) => void): this {
    return super.on('cairn', listener);
  }
  publish(payload: BusEvent): void {
    this.emit('cairn', payload);
    if (this.dashboardUrl) postToDashboard(`${this.dashboardUrl}/events`, payload);
  }
}

export const bus = new EventBus();
