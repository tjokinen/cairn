/**
 * Local x402 facilitator for Arc testnet.
 * Handles verify (EIP-712 signature check) and settle (transferWithAuthorization)
 * for the Arc chain that isn't supported by the standard facilitator.x402.org.
 *
 * Also exposes Express routes at /facilitator/* so operators can point
 * X402_FACILITATOR_URL=http://localhost:<aggregatorPort>/facilitator
 */
import express, { type Router } from 'express';
import { ethers }               from 'ethers';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, VerifyResponse, SettleResponse } from '@x402/core/types';
import type { Network } from '@x402/core/types';
import type { ChainClient } from './chain.js';

const AUTH_TYPES: Record<string, ethers.TypedDataField[]> = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',         type: 'address' },
    { name: 'value',      type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
};

interface EvmAuth {
  from: string; to: string;
  value: string; validAfter: string; validBefore: string; nonce: string;
}

interface RawPayload {
  payload: { authorization: EvmAuth; signature: string };
}

export class LocalFacilitatorClient implements FacilitatorClient {
  private usdcName    = 'USD Coin';
  private usdcVersion = '2';

  constructor(
    private chain: ChainClient,
    private arcChainId: number,
    private usdcAddress: string,
  ) {}

  async init(): Promise<void> {
    try {
      const usdc = new ethers.Contract(
        this.usdcAddress,
        ['function name() view returns (string)', 'function version() view returns (string)'],
        this.chain.provider,
      );
      [this.usdcName, this.usdcVersion] = await Promise.all([usdc.name(), usdc.version()]);
      console.log(`  Facilitator: USDC "${this.usdcName}" v${this.usdcVersion}`);
    } catch {
      console.warn('  Facilitator: using default USDC name/version ("USD Coin" / "2")');
    }
  }

  async verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const p   = payment as unknown as RawPayload;
    const auth = p.payload?.authorization;
    if (!auth) return { isValid: false, invalidReason: 'invalid_payload' };

    const now = Math.floor(Date.now() / 1000);
    if (now < Number(auth.validAfter))  return { isValid: false, invalidReason: 'payment_not_yet_valid' };
    if (now > Number(auth.validBefore)) return { isValid: false, invalidReason: 'payment_expired' };

    const reqs = requirements as unknown as { payTo: string; amount?: string; maxAmountRequired?: string };
    const requiredAmount = reqs.amount ?? reqs.maxAmountRequired;
    if (!requiredAmount) {
      return { isValid: false, invalidReason: 'invalid_payment_requirements' };
    }
    if (auth.to.toLowerCase() !== reqs.payTo.toLowerCase()) {
      return { isValid: false, invalidReason: 'invalid_recipient' };
    }
    if (BigInt(auth.value) < BigInt(requiredAmount)) {
      return { isValid: false, invalidReason: 'insufficient_funds' };
    }

    const domain = {
      name: this.usdcName, version: this.usdcVersion,
      chainId: this.arcChainId, verifyingContract: this.usdcAddress,
    };
    const message = {
      from: auth.from, to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    };

    let recovered: string;
    try {
      // ethers v6: TypedDataEncoder.hash + recoverAddress
      const hash = ethers.TypedDataEncoder.hash(domain, AUTH_TYPES, message);
      recovered  = ethers.recoverAddress(hash, p.payload.signature);
    } catch {
      return { isValid: false, invalidReason: 'invalid_signature' };
    }
    if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
      return { isValid: false, invalidReason: 'invalid_signature' };
    }

    return { isValid: true, payer: auth.from };
  }

  async settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const p   = payment as unknown as RawPayload;
    const auth = p.payload.authorization;
    const net  = (requirements as unknown as { network: string }).network as Network;
    try {
      const txHash = await this.chain.settleTransferWithAuth(
        auth.from, auth.to, auth.value,
        auth.validAfter, auth.validBefore, auth.nonce, p.payload.signature,
      );
      return { success: true, transaction: txHash, network: net };
    } catch (err) {
      return { success: false, errorReason: 'unexpected_settle_error', errorMessage: String(err), transaction: '', network: net };
    }
  }

  async getSupported(): Promise<{ kinds: { x402Version: number; scheme: string; network: Network }[]; extensions: string[]; signers: Record<string, string[]> }> {
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: `eip155:${this.arcChainId}` as Network }],
      extensions: [],
      signers: {},
    };
  }

  // ── Express router mounted at /facilitator ────────────────────────────────

  router(): Router {
    const r = express.Router();
    r.use(express.json());

    r.post('/verify', async (req, res) => {
      try {
        const result = await this.verify(req.body.paymentPayload, req.body.paymentRequirements);
        res.json(result);
      } catch (err) {
        res.status(500).json({ isValid: false, invalidReason: 'unexpected_verify_error', invalidMessage: String(err) });
      }
    });

    r.post('/settle', async (req, res) => {
      try {
        const result = await this.settle(req.body.paymentPayload, req.body.paymentRequirements);
        res.json(result);
      } catch (err) {
        const net = req.body?.paymentRequirements?.network ?? '';
        res.status(500).json({ success: false, errorReason: 'unexpected_settle_error', errorMessage: String(err), transaction: '', network: net });
      }
    });

    r.get('/supported', async (_req, res) => {
      res.json(await this.getSupported());
    });

    return r;
  }
}
