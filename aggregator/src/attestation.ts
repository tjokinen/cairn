/**
 * Builds and posts CairnAttestation structs from VerificationResults.
 *
 * The payloadHash logic lives in @cairn/common so customers can re-derive it
 * client-side from `{ verifiedValue, readings }` they received via the API.
 */
import type { Reading, VerificationResult } from '@cairn/common';
import { buildPayloadHash, canonicalizeReadings } from '@cairn/common';
import type { ChainClient } from './chain.js';

export { canonicalizeReadings };

export interface AttestationContext {
  dataType:  string;
  lat:       number;
  lon:       number;
  timestamp: number;
}

export async function postAttestation(
  ctx:     AttestationContext,
  result:  VerificationResult,
  allReadings: Reading[],
  chain:   ChainClient,
): Promise<string> {
  const payloadHash = buildPayloadHash(result.verifiedValue, allReadings);

  const attestationId = await chain.postAttestation({
    dataType:            ctx.dataType,
    lat:                 ctx.lat,
    lon:                 ctx.lon,
    timestamp:           ctx.timestamp,
    contributingSensors: result.accepted.map((r) => r.sensorId),
    excludedSensors:     [...result.outliers, ...result.malformed].map((r) => r.sensorId),
    confidenceBps:       result.confidenceBps,
    payloadHash,
  });

  return attestationId;
}
