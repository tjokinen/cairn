import { EventEmitter } from 'events';
import axios from 'axios';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { ExactEvmScheme as ExactEvmSchemeClient } from '@x402/evm/exact/client';

export interface BreachCondition {
  op: '>' | '<';
  threshold: number;
  consecutiveReadings: number;
}

export interface Policy {
  policyId:         string;
  policyholder:     string;
  coverageLocation: { lat: number; lon: number };
  dataType:         string;
  breachCondition:  BreachCondition;
  coverageAmountUSDC:    string;
  premiumRatePerSecond:  string;
  durationSeconds:       number;
}

export interface ReadingEntry {
  verifiedValue: number;
  attestationId: string;
  timestamp:     number;
}

export type PolicyStatus = 'monitoring' | 'approaching_threshold' | 'breach' | 'paid';

export interface AgentSnapshot {
  type:           'insurance.snapshot';
  policyId:       string;
  status:         PolicyStatus;
  premiumBalance: string;
  latestValue:    number | null;
  history:        ReadingEntry[];
  timestamp:      number;
}

export interface PolicyPaidEvent {
  type:           'insurance.paid';
  policyId:       string;
  policyholder:   string;
  amountUSDC:     string;
  txHash:         string;
  attestationIds: string[];
  timestamp:      number;
}

export type InsuranceEvent = AgentSnapshot | PolicyPaidEvent;

export class InsuranceRunner extends EventEmitter {
  private history:        ReadingEntry[] = [];
  private premiumBalance: bigint;
  private lastTickAt:     number;
  private status:         PolicyStatus = 'monitoring';
  private paid:           boolean = false;
  private timer:          ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly policy:          Policy,
    private readonly aggregatorUrl:   string,
    private readonly agentWalletId:   string,
    private readonly agentAddress:    `0x${string}`,
    private readonly usdcAddress:     string,
    private readonly arcChainId:      number,
    private readonly circle:          ReturnType<typeof initiateDeveloperControlledWalletsClient>,
  ) {
    super();
    this.premiumBalance = BigInt(policy.premiumRatePerSecond) * BigInt(policy.durationSeconds);
    this.lastTickAt     = Math.floor(Date.now() / 1000);
  }

  emit(event: 'event', payload: InsuranceEvent): boolean {
    return super.emit('event', payload);
  }
  on(event: 'event', listener: (payload: InsuranceEvent) => void): this {
    return super.on('event', listener);
  }

  start(intervalMs = 30_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private makeCircleSigner() {
    const walletId  = this.agentWalletId;
    const address   = this.agentAddress;
    const circle    = this.circle;
    return {
      address,
      async signTypedData(data: {
        domain:      Record<string, unknown>;
        types:       Record<string, unknown>;
        primaryType: string;
        message:     Record<string, unknown>;
      }) {
        const res = await circle.signTypedData({ walletId, data: JSON.stringify(data) });
        const sig = res.data?.signature;
        if (!sig) throw new Error('signTypedData: no signature from Circle');
        return sig as `0x${string}`;
      },
    };
  }

  private async tick(): Promise<void> {
    if (this.paid) return;

    const now     = Math.floor(Date.now() / 1000);
    const elapsed = BigInt(now - this.lastTickAt);
    this.lastTickAt = now;

    // Step 1: deduct elapsed premium
    const deduction = BigInt(this.policy.premiumRatePerSecond) * elapsed;
    this.premiumBalance = this.premiumBalance > deduction
      ? this.premiumBalance - deduction
      : 0n;

    // Step 2: fetch verified reading from aggregator
    const { lat, lon } = this.policy.coverageLocation;
    const queryUrl = `${this.aggregatorUrl}/readings?dataType=${encodeURIComponent(this.policy.dataType)}&lat=${lat}&lon=${lon}&quorum=3`;

    try {
      const entry = await this.fetchReading(queryUrl);
      if (entry) {
        this.history.push(entry);
        if (this.history.length > 100) this.history.shift();
      }
    } catch (err) {
      console.error('[InsuranceRunner] fetchReading failed:', err);
    }

    // Step 3: evaluate breach condition
    const latestValue = this.history.at(-1)?.verifiedValue ?? null;
    if (!this.paid) this.evaluateBreach();

    // Step 4: emit snapshot
    this.status = this.computeStatus();
    this.emit('event', {
      type:           'insurance.snapshot',
      policyId:       this.policy.policyId,
      status:         this.status,
      premiumBalance: this.premiumBalance.toString(),
      latestValue,
      history:        [...this.history],
      timestamp:      now,
    });
  }

  private async fetchReading(url: string): Promise<ReadingEntry | null> {
    const signer = this.makeCircleSigner();
    const scheme = new ExactEvmSchemeClient(signer);

    // Probe for 402
    let paymentHeader: string | undefined;
    try {
      const probe = await axios.get<Record<string, unknown>>(url, { validateStatus: (s) => s <= 402 });
      if (probe.status === 402) {
        const reqsEncoded = (probe.headers as Record<string, string>)['x-payment-requirements']
          ?? (probe.data as Record<string, unknown>)?.['x-payment-requirements'] as string | undefined;
        if (reqsEncoded) {
          const reqs    = JSON.parse(Buffer.from(reqsEncoded, 'base64url').toString('utf8'));
          const reqsArr = Array.isArray(reqs) ? reqs : [reqs];
          if (reqsArr.length > 0) {
            const result = await scheme.createPaymentPayload(1, reqsArr[0] as Parameters<typeof scheme.createPaymentPayload>[1]);
            paymentHeader = Buffer.from(JSON.stringify(result.payload)).toString('base64url');
          }
        }
      } else if (probe.status === 200) {
        return this.parseReadingResponse(probe.data);
      }
    } catch { /* probe failed — try direct */ }

    const resp = await axios.get<Record<string, unknown>>(url, {
      headers: paymentHeader ? { 'X-PAYMENT': paymentHeader } : {},
      validateStatus: (s) => s < 500,
    });
    if (resp.status !== 200) {
      console.warn(`[InsuranceRunner] aggregator returned ${resp.status}`);
      return null;
    }
    return this.parseReadingResponse(resp.data);
  }

  private parseReadingResponse(data: Record<string, unknown>): ReadingEntry {
    return {
      verifiedValue: data['verifiedValue'] as number,
      attestationId: data['attestationId'] as string,
      timestamp:     data['timestamp']     as number,
    };
  }

  private computeStatus(): PolicyStatus {
    if (this.paid) return 'paid';
    const { op, threshold, consecutiveReadings } = this.policy.breachCondition;
    const recent = this.history.slice(-consecutiveReadings);
    if (recent.length < consecutiveReadings) return 'monitoring';

    const breaching = recent.every((e) => op === '>' ? e.verifiedValue > threshold : e.verifiedValue < threshold);
    if (breaching) return 'breach';

    // "approaching": any of the last readings within 10% of threshold
    const margin = Math.abs(threshold) * 0.1;
    const approaching = recent.some((e) =>
      op === '>' ? e.verifiedValue > threshold - margin : e.verifiedValue < threshold + margin,
    );
    return approaching ? 'approaching_threshold' : 'monitoring';
  }

  private evaluateBreach(): void {
    const { op, threshold, consecutiveReadings } = this.policy.breachCondition;
    const recent = this.history.slice(-consecutiveReadings);
    if (recent.length < consecutiveReadings) return;

    const breached = recent.every((e) => op === '>' ? e.verifiedValue > threshold : e.verifiedValue < threshold);
    if (!breached) return;

    this.paid = true;
    const attestationIds = recent.map((e) => e.attestationId);
    void this.triggerPayout(attestationIds);
  }

  private async triggerPayout(attestationIds: string[]): Promise<void> {
    console.log(`[InsuranceRunner] Breach detected — paying out ${this.policy.coverageAmountUSDC} micro-USDC to ${this.policy.policyholder}`);

    try {
      const txRes = await this.circle.createContractExecutionTransaction({
        walletId:         this.agentWalletId,
        contractAddress:  this.usdcAddress,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters:    [this.policy.policyholder, this.policy.coverageAmountUSDC],
        fee: { type: 'level', config: { feeLevel: 'HIGH' } },
      });

      const txId = txRes.data?.id;
      if (!txId) throw new Error('No transaction ID from Circle');

      let txHash = '';
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = await this.circle.getTransaction({ id: txId });
        const tx     = status.data?.transaction;
        if (tx?.state === 'CONFIRMED') { txHash = tx.txHash ?? ''; break; }
        if (tx?.state === 'FAILED') throw new Error(`Payout tx failed: ${tx.errorReason}`);
      }

      this.emit('event', {
        type:           'insurance.paid',
        policyId:       this.policy.policyId,
        policyholder:   this.policy.policyholder,
        amountUSDC:     this.policy.coverageAmountUSDC,
        txHash,
        attestationIds,
        timestamp:      Math.floor(Date.now() / 1000),
      });

      console.log(`[InsuranceRunner] Payout complete: ${txHash}`);
    } catch (err) {
      console.error('[InsuranceRunner] triggerPayout failed:', err);
      this.paid = false; // allow retry on next cycle
    }
  }
}
