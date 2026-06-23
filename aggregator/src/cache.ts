/**
 * Reading cache + per-sensor attribution + batched payout queue.
 *
 * Each cache entry holds a verified attestation plus the contributing sensors
 * and their rates. Subsequent customer queries within the freshness window
 * return the cached attestation and increment the entry's hit count — the
 * contributing sensors are NOT re-queried, but they are still owed their
 * per-query rate for each cache hit. Payouts are batched and settled at
 * cache eviction (entry expiry).
 *
 * `hitCount` counts cache hits ONLY. The initial fetch that created the entry
 * was already paid synchronously via x402 at fetch time — that's why entries
 * start at `hitCount: 0` and we pay `rate * hitCount` (not `rate * (hitCount+1)`)
 * at eviction.
 *
 * Persistence: full snapshot to a single file, rewritten on set/evict and on
 * a checkpoint timer (5s). A crash between checkpoints loses at most ~5 seconds
 * of hit-count increments — acceptable for v0, can swap to JSONL with
 * compaction if throughput needs grow.
 */
import { promises as fs } from 'fs';
import { resolve, dirname } from 'path';

export interface CachedReading {
  sensorId:  number;
  value:     number;
  timestamp: number;
  signature: string;
}

export interface CachedAttestation {
  attestationId:       string;
  verifiedValue:       number;
  unit:                string;
  dataType:            string;
  timestamp:           number;
  confidenceBps:       number;
  contributingSensors: number[];
  excludedSensors:     number[];
  readings:            CachedReading[];
  queryId:             string;
}

export interface SensorAttribution {
  sensorId:     number;
  sensorWallet: string;
  ratePerQuery: number;   // micro-USDC; paid per cache hit at eviction
}

export interface CacheEntry {
  key:         string;
  attestation: CachedAttestation;
  attribution: SensorAttribution[];
  hitCount:    number;
  createdAt:   number;
  expiresAt:   number;
}

export type PayoutCallback = (entries: CacheEntry[]) => Promise<void>;

export function makeCacheKey(
  dataType: string,
  lat: number,
  lon: number,
  radiusKm: number,
  quorum: number,
): string {
  // 4-decimal rounding ≈ 11m precision — same granularity as the existing
  // queryContextCache key, so customers with similar requests share entries.
  return `${dataType}:${lat.toFixed(4)}:${lon.toFixed(4)}:${radiusKm}:${quorum}`;
}

export class ReadingCache {
  private entries = new Map<string, CacheEntry>();
  private evictionTimer:   ReturnType<typeof setInterval> | null = null;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private persistPath: string;
  private dirty = false;

  constructor(
    private payoutCallback: PayoutCallback,
    persistPath: string,
  ) {
    this.persistPath = resolve(persistPath);
  }

  async start(opts: { evictionIntervalMs?: number; checkpointIntervalMs?: number } = {}): Promise<void> {
    const evictMs      = opts.evictionIntervalMs   ?? 10_000;
    const checkpointMs = opts.checkpointIntervalMs ?? 5_000;

    await this.loadFromDisk();

    // Force-expire any restored entries so the next eviction pass flushes them.
    // (By the time we restart, their original freshness windows are likely gone.)
    for (const entry of this.entries.values()) entry.expiresAt = 0;

    void this.evictExpired();
    this.evictionTimer   = setInterval(() => void this.evictExpired(), evictMs);
    this.checkpointTimer = setInterval(() => void this.checkpointIfDirty(), checkpointMs);
  }

  async stop(): Promise<void> {
    if (this.evictionTimer)   clearInterval(this.evictionTimer);
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    await this.checkpointIfDirty();
  }

  /**
   * Returns the cached attestation + its sensor attribution if present and
   * unexpired, and increments hitCount. The server uses the attribution to
   * compute correct operator-earnings totals for the cached response and to
   * keep on-chain recordQuery accurate.
   */
  get(key: string): { attestation: CachedAttestation; attribution: SensorAttribution[] } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) return null;
    entry.hitCount++;
    this.dirty = true;
    return { attestation: entry.attestation, attribution: entry.attribution };
  }

  /** Inserts a fresh entry. hitCount starts at 0 — the initial fetch was already paid via x402. */
  set(
    key: string,
    attestation: CachedAttestation,
    attribution: SensorAttribution[],
    freshnessSeconds: number,
  ): void {
    const now = Date.now();
    const entry: CacheEntry = {
      key,
      attestation,
      attribution,
      hitCount:  0,
      createdAt: now,
      expiresAt: now + freshnessSeconds * 1000,
    };
    this.entries.set(key, entry);
    this.dirty = true;
    void this.checkpoint();
  }

  size(): number {
    return this.entries.size;
  }

  /** Force-evict and settle everything. Used at shutdown or in tests. */
  async drain(): Promise<void> {
    const all = Array.from(this.entries.values());
    this.entries.clear();
    const owed = all.filter((e) => e.hitCount > 0);
    if (owed.length > 0) await this.payoutCallback(owed);
    this.dirty = true;
    await this.checkpoint();
  }

  private async evictExpired(): Promise<void> {
    const now = Date.now();
    const expired: CacheEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        expired.push(entry);
        this.entries.delete(key);
      }
    }
    if (expired.length === 0) return;

    const owed = expired.filter((e) => e.hitCount > 0);
    if (owed.length > 0) {
      try {
        await this.payoutCallback(owed);
      } catch (err) {
        console.error('[cache] payoutCallback failed; re-queuing entries:', err);
        // Restore entries so we retry next cycle. Restored entries are still
        // expired, so they'll evict again immediately.
        for (const entry of owed) this.entries.set(entry.key, entry);
        this.dirty = true;
        return;
      }
    }

    this.dirty = true;
    await this.checkpoint();
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private async checkpointIfDirty(): Promise<void> {
    if (!this.dirty) return;
    await this.checkpoint();
  }

  // Serialize checkpoint writes so concurrent callers (timer + set() + drain())
  // don't race on the .tmp → final rename.
  private checkpointChain: Promise<void> = Promise.resolve();
  private checkpoint(): Promise<void> {
    const next = this.checkpointChain.then(() => this.doCheckpoint());
    this.checkpointChain = next.catch(() => undefined);
    return next;
  }

  private async doCheckpoint(): Promise<void> {
    if (!this.dirty) return;
    try {
      await fs.mkdir(dirname(this.persistPath), { recursive: true });
      const snapshot = Array.from(this.entries.values());
      const tmpPath = `${this.persistPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(snapshot));
      await fs.rename(tmpPath, this.persistPath);
      this.dirty = false;
    } catch (err) {
      console.error('[cache] checkpoint failed:', err);
    }
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.persistPath, 'utf8');
    } catch {
      return; // no prior snapshot
    }
    let snapshot: CacheEntry[];
    try {
      snapshot = JSON.parse(raw) as CacheEntry[];
    } catch (err) {
      console.error('[cache] snapshot parse failed; starting empty:', err);
      return;
    }
    for (const entry of snapshot) {
      this.entries.set(entry.key, entry);
    }
    if (snapshot.length > 0) {
      console.log(`[cache] restored ${snapshot.length} pending entries from disk`);
    }
  }
}
