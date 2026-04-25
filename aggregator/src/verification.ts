import { ethers } from 'ethers';
import type { Reading, DataTypeMetadata, VerificationResult } from '@cairn/common';

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function verify(
  readings: Reading[],
  meta: DataTypeMetadata,
  // wallets: sensorId -> registered wallet address (for signature verification)
  walletMap: Map<number, string>,
): VerificationResult {
  // Step 1 — signature + range validation
  const valid: Reading[]   = [];
  const malformed: Reading[] = [];

  for (const r of readings) {
    // Signature check
    const scaledValue = BigInt(Math.round(r.value * 1_000_000));
    const messageHash = ethers.solidityPackedKeccak256(
      ['uint256', 'int256', 'uint256'],
      [r.sensorId, scaledValue, r.timestamp],
    );
    let recoveredAddr: string;
    try {
      recoveredAddr = ethers.recoverAddress(messageHash, r.signature);
    } catch {
      malformed.push(r);
      continue;
    }
    const expected = walletMap.get(r.sensorId);
    if (!expected || recoveredAddr.toLowerCase() !== expected.toLowerCase()) {
      malformed.push(r);
      continue;
    }
    // Range check
    if (r.value < meta.minValue || r.value > meta.maxValue) {
      malformed.push(r);
      continue;
    }
    valid.push(r);
  }

  if (valid.length < 2) {
    const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(readings)));
    return {
      verifiedValue: valid.length === 1 ? valid[0].value : 0,
      accepted: valid,
      outliers: [],
      malformed,
      confidenceBps: 0,
      payloadHash,
    };
  }

  // Step 2 — MAD outlier detection
  const values = valid.map((r) => r.value);
  const m   = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  const bound = 2.5 * Math.max(mad, meta.expectedVariance);

  const accepted: Reading[] = [];
  const outliers: Reading[] = [];
  for (const r of valid) {
    if (Math.abs(r.value - m) > bound) outliers.push(r);
    else accepted.push(r);
  }

  const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(readings)));

  if (accepted.length < 2) {
    return { verifiedValue: accepted[0]?.value ?? m, accepted, outliers, malformed, confidenceBps: 0, payloadHash };
  }

  // Step 3 — verified value + confidence
  const acceptedValues  = accepted.map((r) => r.value);
  const verifiedValue   = median(acceptedValues);
  const spread          = Math.max(...acceptedValues) - Math.min(...acceptedValues);
  const spreadFactor    = meta.expectedVariance > 0 ? 1 - Math.min(1, spread / meta.expectedVariance) : 1;
  const confidenceBps   = Math.min(10000, Math.max(0,
    3000 + 2000 * (accepted.length - 1) + Math.round(2000 * spreadFactor),
  ));

  return { verifiedValue, accepted, outliers, malformed, confidenceBps, payloadHash };
}
