/**
 * Wraps reputation-update logic for the post-verification step.
 *
 * Deltas (scaled to 1e18 = full reputation):
 *   accepted sensor:  +1e16  (+0.01 = +1%)
 *   outlier sensor:   -5e16  (-0.05 = -5%)
 *
 * SensorRegistry._slash() fires automatically inside updateReputation()
 * when reputation drops below SLASH_THRESHOLD (3e17), so no separate slash
 * call is needed here.
 */
import type { Reading, VerificationResult } from '@cairn/common';
import type { ChainClient } from './chain.js';
import { bus } from './bus.js';

const ACCEPTED_DELTA: bigint =  10_000_000_000_000_000n; // +1e16
const OUTLIER_DELTA:  bigint = -50_000_000_000_000_000n; // -5e16

export async function applyReputationUpdates(
  result: VerificationResult,
  chain: ChainClient,
): Promise<void> {
  const updates: Promise<void>[] = [];

  for (const r of result.accepted) {
    updates.push(
      chain.updateReputation(r.sensorId, ACCEPTED_DELTA)
        .then(() => {
          bus.publish({ type: 'query.reputation_updated', sensorId: r.sensorId, delta: ACCEPTED_DELTA.toString(), bucket: 'accepted' });
        })
        .catch((err: unknown) => console.error(`updateReputation(${r.sensorId}) failed:`, err)),
    );
  }

  for (const r of result.outliers) {
    updates.push(
      chain.updateReputation(r.sensorId, OUTLIER_DELTA)
        .then(() => {
          bus.publish({ type: 'query.reputation_updated', sensorId: r.sensorId, delta: OUTLIER_DELTA.toString(), bucket: 'outlier' });
        })
        .catch((err: unknown) => console.error(`updateReputation(${r.sensorId}) failed:`, err)),
    );
  }

  // Fire all in parallel; failures are logged but not thrown
  await Promise.allSettled(updates);
}

/** Compute reputation deltas for a set of readings without making on-chain calls. */
export function computeDeltas(result: VerificationResult): Map<number, bigint> {
  const deltas = new Map<number, bigint>();
  for (const r of result.accepted) deltas.set(r.sensorId, ACCEPTED_DELTA);
  for (const r of result.outliers) deltas.set(r.sensorId, OUTLIER_DELTA);
  return deltas;
}

/** Estimate how many rogue cycles until a sensor's reputation hits SLASH_THRESHOLD.
 *  Starting reputation is 1e18, threshold is 3e17.
 *  Each rogue cycle: -5e16
 *  Cycles = floor((1e18 - 3e17) / 5e16) = 14
 */
export function cyclesUntilSlash(currentReputation: bigint): number {
  const SLASH_THRESHOLD = 300_000_000_000_000_000n; // 3e17
  if (currentReputation <= SLASH_THRESHOLD) return 0;
  return Number((currentReputation - SLASH_THRESHOLD) / (-OUTLIER_DELTA));
}
