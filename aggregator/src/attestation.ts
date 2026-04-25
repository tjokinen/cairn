/**
 * Builds and posts CairnAttestation structs from VerificationResults.
 *
 * payloadHash = keccak256 of canonicalized JSON containing all readings + signatures,
 * providing an on-chain link to the raw evidence.
 */
import { ethers } from 'ethers';
import type { Reading, VerificationResult } from '@cairn/common';
import type { ChainClient } from './chain.js';

export interface AttestationContext {
  dataType:  string;
  lat:       number;
  lon:       number;
  timestamp: number;
}

export function buildPayloadHash(readings: Reading[]): string {
  // Canonical: sorted by sensorId, stable JSON
  const canonical = [...readings]
    .sort((a, b) => a.sensorId - b.sensorId)
    .map((r) => ({
      sensorId:  r.sensorId,
      value:     r.value,
      timestamp: r.timestamp,
      signature: r.signature,
    }));
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(canonical)));
}

export async function postAttestation(
  ctx:     AttestationContext,
  result:  VerificationResult,
  allReadings: Reading[],
  chain:   ChainClient,
): Promise<string> {
  const payloadHash = buildPayloadHash(allReadings);

  const attestationId = await chain.postAttestation({
    dataType:            ctx.dataType,
    lat:                 ctx.lat,
    lon:                 ctx.lon,
    timestamp:           ctx.timestamp,
    contributingSensors: result.accepted.map((r) => r.sensorId),
    excludedSensors:     [...result.outliers, ...result.malformed].map((r) => r.sensorId),
    verifiedValue:       result.verifiedValue,
    confidenceBps:       result.confidenceBps,
    payloadHash,
  });

  return attestationId;
}
