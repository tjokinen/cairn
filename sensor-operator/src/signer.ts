/**
 * Signs sensor readings using the operator's Circle wallet.
 * Message: keccak256(abi.encodePacked(sensorId, scaledValue, timestamp))
 * where scaledValue = Math.round(value * 1e6) — same scaling as contract storage.
 *
 * Verifier (WP-05) recovers the signer with ethers.recoverAddress(messageHash, signature)
 * and checks it against the sensor's registered wallet address.
 */
import { ethers } from 'ethers';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

export class ReadingSigner {
  private circle: ReturnType<typeof initiateDeveloperControlledWalletsClient>;

  constructor() {
    this.circle = initiateDeveloperControlledWalletsClient({
      apiKey:       requireEnv('CIRCLE_API_KEY'),
      entitySecret: requireEnv('CIRCLE_ENTITY_SECRET'),
    });
  }

  async sign(walletId: string, sensorId: number, value: number, timestamp: number): Promise<string> {
    const scaledValue = BigInt(Math.round(value * 1_000_000));
    const messageHash = ethers.solidityPackedKeccak256(
      ['uint256', 'int256', 'uint256'],
      [sensorId, scaledValue, timestamp],
    );

    const res = await this.circle.signMessage({
      walletId,
      message:      messageHash,
      encodedByHex: true,
    });

    const sig = res.data?.signature;
    if (!sig) throw new Error(`Failed to sign reading for wallet ${walletId}`);
    return sig;
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
