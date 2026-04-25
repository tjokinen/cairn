import { EventEmitter } from 'events';
import axios from 'axios';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { ExactEvmScheme as ExactEvmSchemeClient } from '@x402/evm/exact/client';
import { BatchEvmScheme, CompositeEvmScheme } from '@circle-fin/x402-batching/client';
import type { BatchEvmSigner } from '@circle-fin/x402-batching';
import type { Network } from '@x402/core/types';

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

type RequirementCandidate = {
  x402Version: number;
  requirement: Record<string, unknown>;
};

function decodeBase64Json(encoded: string): unknown | null {
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    try {
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    } catch {
      return null;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequirements(raw: unknown): RequirementCandidate[] {
  const out: RequirementCandidate[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const x402Version = typeof entry['x402Version'] === 'number'
        ? entry['x402Version']
        : typeof entry['amount'] === 'string' ? 2 : 1;
      out.push({ x402Version, requirement: entry });
    }
    return out;
  }

  if (isRecord(raw) && Array.isArray(raw['accepts'])) {
    const rootVersion = typeof raw['x402Version'] === 'number' ? raw['x402Version'] : undefined;
    for (const entry of raw['accepts']) {
      if (!isRecord(entry)) continue;
      const x402Version = rootVersion
        ?? (typeof entry['x402Version'] === 'number' ? entry['x402Version'] : undefined)
        ?? (typeof entry['amount'] === 'string' ? 2 : 1);
      out.push({ x402Version, requirement: entry });
    }
    return out;
  }

  if (isRecord(raw)) {
    const x402Version = typeof raw['x402Version'] === 'number'
      ? raw['x402Version']
      : typeof raw['amount'] === 'string' ? 2 : 1;
    out.push({ x402Version, requirement: raw });
  }

  return out;
}

function parsePaymentRequiredCandidates(probe: Record<string, unknown>, headers: Record<string, string | undefined>): RequirementCandidate[] {
  const encoded = headers['payment-required']
    ?? headers['PAYMENT-REQUIRED']
    // Legacy compatibility for older x402 header variants.
    ?? headers['x-payment-requirements']
    ?? (probe['x-payment-requirements'] as string | undefined);

  if (!encoded) return [];
  const decoded = decodeBase64Json(encoded);
  if (decoded == null) return [];
  return normalizeRequirements(decoded);
}

function isGatewayBatchOption(requirement: Record<string, unknown>): boolean {
  const extra = requirement['extra'];
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return false;
  const name = (extra as Record<string, unknown>)['name'];
  return typeof name === 'string' && name.toLowerCase() === 'gatewaywalletbatched';
}

function selectRequirementsForAgent(candidates: RequirementCandidate[], arcNetwork: Network): RequirementCandidate[] {
  const matchesArcExact = candidates.filter(({ requirement }) =>
    requirement['scheme'] === 'exact' && requirement['network'] === arcNetwork,
  );
  if (matchesArcExact.length === 0) return [];

  // Actively prefer Circle Gateway batched payments.
  const gatewayPreferred = matchesArcExact.filter(({ requirement }) => isGatewayBatchOption(requirement));
  const fallback = matchesArcExact.filter(({ requirement }) => !isGatewayBatchOption(requirement));
  return [...gatewayPreferred, ...fallback];
}

function buildPaymentPayloadEnvelope(
  requirement: RequirementCandidate,
  created: { payload: unknown; extensions?: Record<string, unknown> },
): Record<string, unknown> {
  if (requirement.x402Version === 1) {
    return {
      x402Version: 1,
      scheme: requirement.requirement['scheme'],
      network: requirement.requirement['network'],
      payload: created.payload,
    };
  }

  return {
    x402Version: 2,
    accepted: requirement.requirement,
    payload: created.payload,
    ...(created.extensions ? { extensions: created.extensions } : {}),
  };
}

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

  private makeCircleSigner(): BatchEvmSigner {
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
    } as BatchEvmSigner;
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
    const arcNetwork = `eip155:${this.arcChainId}` as Network;
    const signer = this.makeCircleSigner();
    const scheme = new CompositeEvmScheme(
      new BatchEvmScheme(signer),
      new ExactEvmSchemeClient(signer),
    );

    // Probe for 402
    let requirementOrder: RequirementCandidate[] = [];
    try {
      const probe = await axios.get<Record<string, unknown>>(url, { validateStatus: (s) => s <= 402 });
      if (probe.status === 402) {
        const candidates = parsePaymentRequiredCandidates(
          probe.data,
          probe.headers as Record<string, string | undefined>,
        );
        requirementOrder = selectRequirementsForAgent(candidates, arcNetwork);
      } else if (probe.status === 200) {
        return this.parseReadingResponse(probe.data);
      }
    } catch { /* probe failed — try direct */ }

    if (requirementOrder.length > 0) {
      for (const [idx, selectedRequirement] of requirementOrder.entries()) {
        try {
          const created = await scheme.createPaymentPayload(
            selectedRequirement.x402Version,
            selectedRequirement.requirement as unknown as Parameters<CompositeEvmScheme['createPaymentPayload']>[1],
          );
          const payload = buildPaymentPayloadEnvelope(selectedRequirement, created);
          const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

          const paidResp = await axios.get<Record<string, unknown>>(url, {
            headers: { 'PAYMENT-SIGNATURE': paymentHeader },
            validateStatus: (s) => s < 500,
          });
          if (paidResp.status === 200) {
            return this.parseReadingResponse(paidResp.data);
          }
          console.warn(`[InsuranceRunner] payment option ${idx + 1}/${requirementOrder.length} returned ${paidResp.status}`);
        } catch {
          // Keep trying fallback requirements from the same 402 response.
        }
      }
      return null;
    }

    const resp = await axios.get<Record<string, unknown>>(url, {
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
