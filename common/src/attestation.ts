/**
 * Attestation hashing utilities, shared between the aggregator (server side)
 * and customer SDKs (client side).
 *
 * The on-chain CairnAttestation does NOT store the verified value — only the
 * payloadHash that commits to it. A customer who received `{ verifiedValue,
 * readings }` from the aggregator API can rebuild the same hash here and
 * compare it against `payloadHash` from `getAttestation(attestationId)`.
 *
 * This module intentionally has no aggregator-side imports; it must remain
 * trivially usable from any client (browser, agent runtime, smart-contract
 * tooling that needs a JS reference impl).
 */
import { keccak256, toUtf8Bytes } from 'ethers';

export interface CanonicalReading {
  sensorId:  number;
  value:     number;
  timestamp: number;
  signature: string;
}

export function canonicalizeReadings(
  readings: Array<{ sensorId: number; value: number; timestamp: number; signature: string }>,
): CanonicalReading[] {
  return [...readings]
    .sort((a, b) => a.sensorId - b.sensorId)
    .map((r) => ({
      sensorId:  r.sensorId,
      value:     r.value,
      timestamp: r.timestamp,
      signature: r.signature,
    }));
}

/**
 * Hash that commits to both the platform-derived verified value AND the raw
 * readings it was derived from. This is the value stored in `CairnAttestation.payloadHash`.
 *
 * Stable representation: verifiedValue is scaled to 1e6 fixed-point integer
 * (matching the int256 representation used elsewhere); readings are sorted
 * by sensorId. The full payload is serialized as JSON and hashed with keccak256.
 */
export function buildPayloadHash(
  verifiedValue: number,
  readings: Array<{ sensorId: number; value: number; timestamp: number; signature: string }>,
): string {
  const canonical = canonicalizeReadings(readings);
  const payload = JSON.stringify({
    verifiedValue: Math.round(verifiedValue * 1_000_000),
    readings:      canonical,
  });
  return keccak256(toUtf8Bytes(payload));
}

/**
 * Verify that a (verifiedValue, readings) tuple matches a stored payloadHash.
 * Use after fetching the on-chain Attestation via `getAttestation(attestationId)`.
 */
export function verifyAttestation(
  verifiedValue: number,
  readings: Array<{ sensorId: number; value: number; timestamp: number; signature: string }>,
  storedPayloadHash: string,
): boolean {
  return buildPayloadHash(verifiedValue, readings) === storedPayloadHash;
}
