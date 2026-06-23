/**
 * Tests for the reading cache + per-sensor attribution + batched payout queue.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { tmpdir } from 'os';

import {
  ReadingCache,
  makeCacheKey,
  type CachedAttestation,
  type CacheEntry,
  type SensorAttribution,
} from '../src/cache.js';

function makeAttestation(id: string, value = 28.15): CachedAttestation {
  return {
    attestationId:       id,
    verifiedValue:       value,
    unit:                'degC',
    dataType:            'weather.temperature_c',
    timestamp:           1700000000,
    confidenceBps:       7500,
    contributingSensors: [1, 2, 3],
    excludedSensors:     [],
    readings:            [],
    queryId:             '0xqid',
  };
}

const ATTR_3: SensorAttribution[] = [
  { sensorId: 1, sensorWallet: '0xwallet1', ratePerQuery: 100 },
  { sensorId: 2, sensorWallet: '0xwallet2', ratePerQuery: 200 },
  { sensorId: 3, sensorWallet: '0xwallet3', ratePerQuery: 100 },
];

async function makeTmpPath(label: string): Promise<string> {
  return resolve(tmpdir(), `cairn-cache-${label}-${Date.now()}-${Math.random()}.json`);
}

describe('makeCacheKey', () => {
  test('rounds coordinates to 4 decimals', () => {
    const a = makeCacheKey('weather.temperature_c', 18.90001, -103.87001, 15, 3);
    const b = makeCacheKey('weather.temperature_c', 18.90004, -103.87004, 15, 3);
    assert.equal(a, b);
  });

  test('different params produce different keys', () => {
    const k1 = makeCacheKey('weather.temperature_c', 18.9, -103.87, 15, 3);
    const k2 = makeCacheKey('weather.humidity_pct',  18.9, -103.87, 15, 3);
    const k3 = makeCacheKey('weather.temperature_c', 18.9, -103.87, 20, 3);
    const k4 = makeCacheKey('weather.temperature_c', 18.9, -103.87, 15, 5);
    assert.notEqual(k1, k2);
    assert.notEqual(k1, k3);
    assert.notEqual(k1, k4);
  });
});

describe('ReadingCache', () => {
  test('get on empty cache returns null', async () => {
    const persistPath = await makeTmpPath('empty');
    const cache = new ReadingCache(async () => {}, persistPath);
    try {
      assert.equal(cache.get('any-key'), null);
    } finally {
      await cache.stop();
      await fs.unlink(persistPath).catch(() => {});
    }
  });

  test('set then get returns attestation + attribution and increments hitCount', async () => {
    const persistPath = await makeTmpPath('basic');
    const payouts: CacheEntry[][] = [];
    const cache = new ReadingCache(async (entries) => { payouts.push(entries); }, persistPath);
    try {
      cache.set('key1', makeAttestation('att1'), ATTR_3, 60);

      const hit1 = cache.get('key1');
      assert.ok(hit1);
      assert.equal(hit1.attestation.attestationId, 'att1');
      assert.equal(hit1.attribution.length, 3);

      // Second get should still hit
      const hit2 = cache.get('key1');
      assert.ok(hit2);
    } finally {
      await cache.stop();
      await fs.unlink(persistPath).catch(() => {});
    }
  });

  test('expired entries return null', async () => {
    const persistPath = await makeTmpPath('expiry');
    const cache = new ReadingCache(async () => {}, persistPath);
    try {
      // 0-second freshness window → expires immediately
      cache.set('key1', makeAttestation('att1'), ATTR_3, 0);
      // Make sure time has advanced past the expiry
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(cache.get('key1'), null);
    } finally {
      await cache.stop();
      await fs.unlink(persistPath).catch(() => {});
    }
  });

  test('drain settles entries with hitCount > 0', async () => {
    const persistPath = await makeTmpPath('drain');
    let payoutEntries: CacheEntry[] = [];
    const cache = new ReadingCache(async (entries) => { payoutEntries = entries; }, persistPath);
    try {
      cache.set('key1', makeAttestation('att1'), ATTR_3, 60);
      cache.get('key1');
      cache.get('key1');
      cache.get('key1');

      await cache.drain();

      assert.equal(payoutEntries.length, 1);
      assert.equal(payoutEntries[0].hitCount, 3);
      assert.equal(payoutEntries[0].attribution.length, 3);
    } finally {
      await cache.stop();
      await fs.unlink(persistPath).catch(() => {});
    }
  });

  test('drain skips entries with hitCount = 0', async () => {
    const persistPath = await makeTmpPath('drain-empty');
    let invoked = false;
    const cache = new ReadingCache(async () => { invoked = true; }, persistPath);
    try {
      // set but never get → hitCount stays 0
      cache.set('key1', makeAttestation('att1'), ATTR_3, 60);
      await cache.drain();
      // payoutCallback should not be invoked when no entries owe anything
      assert.equal(invoked, false);
    } finally {
      await cache.stop();
      await fs.unlink(persistPath).catch(() => {});
    }
  });

  test('persistence: snapshot survives restart', async () => {
    const persistPath = await makeTmpPath('persist');
    try {
      const cache1 = new ReadingCache(async () => {}, persistPath);
      // Long freshness so the entry doesn't auto-expire across restart
      cache1.set('key1', makeAttestation('att1'), ATTR_3, 3600);
      cache1.get('key1');
      cache1.get('key1');
      await cache1.stop(); // flushes checkpoint

      // New cache instance picks up the snapshot. On startup it force-expires
      // restored entries so the next eviction pass flushes them — this is by
      // design (a restart treats prior entries as needing settlement).
      const settled: CacheEntry[] = [];
      const cache2 = new ReadingCache(async (entries) => { settled.push(...entries); }, persistPath);
      await cache2.start({ evictionIntervalMs: 50, checkpointIntervalMs: 50 });
      // Give the eviction pass a chance to run
      await new Promise((r) => setTimeout(r, 100));
      await cache2.stop();

      assert.equal(settled.length, 1, 'restored entry should have been settled');
      assert.equal(settled[0].hitCount, 2);
    } finally {
      await fs.unlink(persistPath).catch(() => {});
    }
  });
});
