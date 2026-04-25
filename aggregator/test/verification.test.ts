/**
 * WP-05 acceptance-criteria tests for the verification engine.
 *
 * Uses Node.js built-in test runner (node:test).
 * Run: node --import tsx/esm --test aggregator/test/verification.test.ts
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { verify } from '../src/verification.js';
import type { Reading, DataTypeMetadata } from '@cairn/common';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sign a reading the same way ReadingSigner does in sensor-operator.
 * Circle signMessage with encodedByHex:true signs the raw hash (no EIP-191 prefix).
 * Ethers: wallet.signingKey.sign(hash) does the same raw signing.
 * verification.ts recovers with ethers.recoverAddress(messageHash, sig) — raw, no prefix.
 */
function signReading(
  wallet: ethers.Wallet,
  sensorId: number,
  value: number,
  timestamp: number,
): string {
  const scaledValue = BigInt(Math.round(value * 1_000_000));
  const messageHash = ethers.solidityPackedKeccak256(
    ['uint256', 'int256', 'uint256'],
    [sensorId, scaledValue, timestamp],
  );
  const sig = wallet.signingKey.sign(messageHash);
  return ethers.Signature.from(sig).serialized;
}

function makeReading(
  wallet: ethers.Wallet,
  sensorId: number,
  value: number,
  timestamp: number,
  sig: string,
): Reading {
  return { sensorId, sensorWallet: wallet.address, value, timestamp, signature: sig };
}

const TEMPERATURE_META: DataTypeMetadata = {
  id: 'weather.temperature_c',
  unit: 'degC',
  minValue: -50,
  maxValue: 60,
  expectedVariance: 1.0,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('verify() — outlier detection', () => {
  const wallets = [1, 2, 3, 4, 5].map(() => ethers.Wallet.createRandom());
  const TS = 1_700_000_000;
  const readings: Reading[] = [];
  const walletMap = new Map<number, string>();

  before(async () => {
    const values = [28.1, 28.3, 28.0, 28.2, 5.0];
    for (let i = 0; i < wallets.length; i++) {
      const sensorId = i + 1;
      walletMap.set(sensorId, wallets[i].address);
      const sig = await signReading(wallets[i], sensorId, values[i], TS);
      readings.push(makeReading(wallets[i], sensorId, values[i], TS, sig));
    }
  });

  test('identifies 5.0 as the sole outlier', async () => {
    const result = verify(readings, TEMPERATURE_META, walletMap);
    assert.equal(result.outliers.length, 1);
    assert.equal(result.outliers[0].value, 5.0);
  });

  test('accepted set has 4 readings', async () => {
    const result = verify(readings, TEMPERATURE_META, walletMap);
    assert.equal(result.accepted.length, 4);
  });

  test('verifiedValue ≈ 28.15 (median of accepted)', async () => {
    const result = verify(readings, TEMPERATURE_META, walletMap);
    // median of [28.0, 28.1, 28.2, 28.3] = (28.1 + 28.2) / 2 = 28.15
    assert.ok(Math.abs(result.verifiedValue - 28.15) < 0.001,
      `expected ≈28.15, got ${result.verifiedValue}`);
  });

  test('malformed is empty (all signatures valid)', async () => {
    const result = verify(readings, TEMPERATURE_META, walletMap);
    assert.equal(result.malformed.length, 0);
  });
});

describe('verify() — confidence', () => {
  const wallets = [1, 2].map(() => ethers.Wallet.createRandom());
  const TS = 1_700_000_001;
  const walletMap = new Map<number, string>([[1, wallets[0].address], [2, wallets[1].address]]);

  test('2 honest readings give confidenceBps > 3000', async () => {
    const r1sig = await signReading(wallets[0], 1, 22.0, TS);
    const r2sig = await signReading(wallets[1], 2, 22.1, TS);
    const readings: Reading[] = [
      makeReading(wallets[0], 1, 22.0, TS, r1sig),
      makeReading(wallets[1], 2, 22.1, TS, r2sig),
    ];
    const result = verify(readings, TEMPERATURE_META, walletMap);
    assert.equal(result.accepted.length, 2);
    assert.ok(result.confidenceBps > 3000,
      `expected confidenceBps > 3000, got ${result.confidenceBps}`);
  });

  test('fewer than 2 valid readings gives confidenceBps = 0', async () => {
    const r1sig = await signReading(wallets[0], 1, 22.0, TS);
    // Only one reading (no second sensor)
    const readings: Reading[] = [makeReading(wallets[0], 1, 22.0, TS, r1sig)];
    const singleMap = new Map([[1, wallets[0].address]]);
    const result = verify(readings, TEMPERATURE_META, singleMap);
    assert.equal(result.confidenceBps, 0);
  });
});

describe('verify() — signature & range validation', () => {
  const wallet = ethers.Wallet.createRandom();
  const TS = 1_700_000_002;

  test('tampered value → malformed, not outlier', async () => {
    // Sign with value 25.0, but report 99.0 in the reading body
    const sig = await signReading(wallet, 1, 25.0, TS);
    const reading: Reading = makeReading(wallet, 1, 99.0, TS, sig);
    const walletMap = new Map([[1, wallet.address]]);
    const result = verify([reading], TEMPERATURE_META, walletMap);
    assert.equal(result.malformed.length, 1);
    assert.equal(result.outliers.length, 0);
  });

  test('bad signature hex → malformed', async () => {
    const reading: Reading = makeReading(wallet, 1, 25.0, TS, '0xdeadbeef');
    const walletMap = new Map([[1, wallet.address]]);
    const result = verify([reading], TEMPERATURE_META, walletMap);
    assert.equal(result.malformed.length, 1);
  });

  test('wrong signer (wallet mismatch) → malformed', async () => {
    const otherWallet = ethers.Wallet.createRandom();
    const sig = await signReading(otherWallet, 1, 25.0, TS); // signed by wrong wallet
    const reading: Reading = makeReading(wallet, 1, 25.0, TS, sig);
    const walletMap = new Map([[1, wallet.address]]); // registered wallet is 'wallet'
    const result = verify([reading], TEMPERATURE_META, walletMap);
    assert.equal(result.malformed.length, 1);
  });

  test('value outside range [minValue, maxValue] → malformed', async () => {
    const outOfRange = 999.0; // above maxValue=60
    const sig = await signReading(wallet, 1, outOfRange, TS);
    const reading: Reading = makeReading(wallet, 1, outOfRange, TS, sig);
    const walletMap = new Map([[1, wallet.address]]);
    const result = verify([reading], TEMPERATURE_META, walletMap);
    assert.equal(result.malformed.length, 1);
  });
});

describe('verify() — MAD bound uses expectedVariance floor', () => {
  test('tight cluster still detects outlier when variance floor prevents narrow bound', async () => {
    // 4 readings within 0.01 of each other, plus one 3 units away
    // Without expectedVariance floor: bound = 2.5 * MAD ≈ 0.025 → both 0.01 and 3.0 would be outliers
    // With floor max(MAD, 1.0): bound = 2.5 * 1.0 = 2.5 → only 3.0 is outlier
    const ws = [1, 2, 3, 4, 5].map(() => ethers.Wallet.createRandom());
    const TS2 = 1_700_000_003;
    const values = [20.00, 20.01, 20.02, 20.01, 23.0];
    const readings: Reading[] = [];
    const wm = new Map<number, string>();
    for (let i = 0; i < ws.length; i++) {
      wm.set(i + 1, ws[i].address);
      const sig = await signReading(ws[i], i + 1, values[i], TS2);
      readings.push(makeReading(ws[i], i + 1, values[i], TS2, sig));
    }
    const result = verify(readings, TEMPERATURE_META, wm);
    assert.equal(result.outliers.length, 1, `expected 1 outlier, got ${result.outliers.length}`);
    assert.equal(result.outliers[0].value, 23.0);
    assert.equal(result.accepted.length, 4);
  });
});
