import 'dotenv/config';
import express              from 'express';
import axios                from 'axios';
import type { AxiosResponse } from 'axios';
import { ethers }           from 'ethers';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { ExactEvmScheme as ExactEvmSchemeClient } from '@x402/evm/exact/client';
import { GatewayEvmScheme, BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { BatchEvmScheme, CompositeEvmScheme } from '@circle-fin/x402-batching/client';
import type { BatchEvmSigner } from '@circle-fin/x402-batching';
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types';
import type { FacilitatorClient } from '@x402/core/server';
import type { Deployments } from '@cairn/common';
import type { DiscoveryService } from './discovery.js';
import type { ChainClient }      from './chain.js';
import type { LocalFacilitatorClient } from './facilitator.js';
import { verify as verifyReadings }      from './verification.js';
import { applyReputationUpdates }        from './reputation.js';
import { postAttestation } from './attestation.js';
import { bus }                           from './bus.js';
import type { QueryContext, SensorReading } from './types.js';

const PROTOCOL_FEE_BPS = 200; // 2%

function makeCircleClientSigner(
  walletId: string,
  address: `0x${string}`,
  circle: ReturnType<typeof import('@circle-fin/developer-controlled-wallets').initiateDeveloperControlledWalletsClient>,
): BatchEvmSigner {
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

function buildGatewayFacilitatorClient(gatewayUrl: string): FacilitatorClient {
  const gatewayFacilitator = new BatchFacilitatorClient({ url: gatewayUrl });

  return {
    verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
      return gatewayFacilitator.verify(
        payment as unknown as Parameters<BatchFacilitatorClient['verify']>[0],
        requirements as unknown as Parameters<BatchFacilitatorClient['verify']>[1],
      ) as unknown as Promise<VerifyResponse>;
    },
    settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      return gatewayFacilitator.settle(
        payment as unknown as Parameters<BatchFacilitatorClient['settle']>[0],
        requirements as unknown as Parameters<BatchFacilitatorClient['settle']>[1],
      ) as unknown as Promise<SettleResponse>;
    },
    async getSupported() {
      return gatewayFacilitator.getSupported() as unknown as ReturnType<FacilitatorClient['getSupported']>;
    },
  };
}

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

function extractPayer(req: express.Request): string {
  const header = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined;
  if (!header) return ethers.ZeroAddress;
  const decoded = decodeBase64Json(header);
  if (!isRecord(decoded)) return ethers.ZeroAddress;

  const payload = isRecord(decoded['payload']) ? decoded['payload'] : decoded;
  if (!isRecord(payload)) return ethers.ZeroAddress;

  const authorization = payload['authorization'];
  if (!isRecord(authorization)) return ethers.ZeroAddress;

  return (authorization['from'] as string | undefined) ?? ethers.ZeroAddress;
}

const queryContextCache = new Map<string, QueryContext>();

function cacheKey(dataType: string, lat: number, lon: number, radiusKm: number, quorum: number) {
  return `${dataType}:${lat.toFixed(4)}:${lon.toFixed(4)}:${radiusKm}:${quorum}`;
}

type RequirementCandidate = {
  x402Version: number;
  requirement: Record<string, unknown>;
};

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

function parsePaymentRequiredCandidates(probe: AxiosResponse<Record<string, unknown>>): RequirementCandidate[] {
  const headers = probe.headers as Record<string, string | undefined>;
  const encoded = headers['payment-required']
    ?? headers['PAYMENT-REQUIRED']
    // Legacy compatibility for older x402 header variants.
    ?? headers['x-payment-requirements']
    ?? ((probe.data as Record<string, unknown>)?.['x-payment-requirements'] as string | undefined);

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

function selectRequirementsForAggregator(
  candidates: RequirementCandidate[],
  arcNetwork: Network,
): RequirementCandidate[] {
  const matchesArcExact = candidates.filter(({ requirement }) =>
    requirement['scheme'] === 'exact' && requirement['network'] === arcNetwork,
  );
  if (matchesArcExact.length === 0) return [];

  // Actively prefer Circle Gateway batched payments; then try any exact Arc fallback options.
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

function readHeader(headers: Record<string, unknown>, key: string): string | undefined {
  const value = headers[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function extractSettlementTransaction(headers: Record<string, unknown>): string {
  const encoded = readHeader(headers, 'payment-response') ?? readHeader(headers, 'x-payment-response');
  if (!encoded) return '';

  const decoded = decodeBase64Json(encoded);
  if (!isRecord(decoded)) return '';

  const tx = decoded['transaction'];
  return typeof tx === 'string' ? tx : '';
}

export function buildServer(
  deployments:         Deployments,
  discovery:           DiscoveryService,
  chain:               ChainClient,
  facilitator:         LocalFacilitatorClient,
  aggregatorWalletId:  string,
  aggregatorAddress:   string,
  aggregatorPort:      number,
): express.Application {

  const usdcAddress = process.env.USDC_ADDRESS!;
  const arcChainId  = deployments.arcChainId;
  const arcNetwork  = `eip155:${arcChainId}` as Network;
  const defaultGatewayUrl = 'https://gateway-api-testnet.circle.com/gateway';
  const gatewayUrl = (process.env.CIRCLE_GATEWAY_URL?.trim() || defaultGatewayUrl).replace(/\/+$/, '');

  const clientSigner = makeCircleClientSigner(aggregatorWalletId, aggregatorAddress as `0x${string}`, chain.circle);
  const evmClientScheme = new CompositeEvmScheme(
    new BatchEvmScheme(clientSigner),
    new ExactEvmSchemeClient(clientSigner),
  );

  const evmServerScheme = new GatewayEvmScheme();
  evmServerScheme.registerMoneyParser(async (amountDecimal, network) => {
    if (network !== arcNetwork) return null;
    return { amount: Math.round(amountDecimal * 1_000_000).toString(), asset: usdcAddress };
  });

  const facilitatorClients: FacilitatorClient[] = [
    buildGatewayFacilitatorClient(gatewayUrl),
    facilitator,
  ];
  const resourceServer = new x402ResourceServer(facilitatorClients).register(arcNetwork, evmServerScheme);

  const app = express();
  app.use(express.json());

  app.use('/facilitator', facilitator.router());
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Dynamic price function — runs before 402 is returned to client
  const dynamicPrice = async (ctx: { adapter: { getQueryParams(): Record<string, string | string[]> } }) => {
    const p = ctx.adapter.getQueryParams();
    const dataType = (p['dataType'] ?? '') as string;
    const lat      = parseFloat((p['lat']      as string) ?? '0');
    const lon      = parseFloat((p['lon']      as string) ?? '0');
    const radiusKm = parseFloat((p['radiusKm'] as string) ?? '15');
    const quorum   = parseInt  ((p['quorum']   as string) ?? '3', 10);

    const sensors  = discovery.findSensors(dataType, lat, lon, radiusKm);
    const selected = discovery.selectTopSensors(sensors, quorum);

    const basePrice     = selected.reduce((s, x) => s + x.ratePerQuery, 0);
    const customerPrice = Math.ceil(basePrice * (10000 + PROTOCOL_FEE_BPS) / 10000);
    const priceUSD      = `$${(Math.max(customerPrice, 1) / 1_000_000).toFixed(7)}`;

    queryContextCache.set(
      cacheKey(dataType, lat, lon, radiusKm, quorum),
      { dataType, lat, lon, radiusKm, quorum, selectedSensors: selected, basePrice, customerPrice },
    );
    return priceUSD;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: Record<string, any> = {
    'GET /readings': {
      accepts: {
        scheme:  'exact',
        network: arcNetwork,
        payTo:   aggregatorAddress,
        price:   dynamicPrice,
        extra:   { name: 'USD Coin', version: '2' },
      },
      description: 'Verified environmental reading from the Cairn oracle network',
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use(paymentMiddleware(routes as any, resourceServer));

  // ── GET /readings ────────────────────────────────────────────────────────────
  app.get('/readings', async (req, res) => {
    const dataType = req.query['dataType'] as string;
    const lat      = parseFloat(req.query['lat']      as string ?? '0');
    const lon      = parseFloat(req.query['lon']      as string ?? '0');
    const radiusKm = parseFloat(req.query['radiusKm'] as string ?? '15');
    const quorum   = parseInt  (req.query['quorum']   as string ?? '3', 10);

    if (!dataType) { res.status(400).json({ error: 'Missing ?dataType=' }); return; }

    const key = cacheKey(dataType, lat, lon, radiusKm, quorum);
    let ctx = queryContextCache.get(key);
    if (!ctx) {
      const sensors  = discovery.findSensors(dataType, lat, lon, radiusKm);
      const selected = discovery.selectTopSensors(sensors, quorum);
      const basePrice     = selected.reduce((s, x) => s + x.ratePerQuery, 0);
      const customerPrice = Math.ceil(basePrice * (10000 + PROTOCOL_FEE_BPS) / 10000);
      ctx = { dataType, lat, lon, radiusKm, quorum, selectedSensors: selected, basePrice, customerPrice };
    }
    queryContextCache.delete(key);

    const { selectedSensors, basePrice, customerPrice } = ctx;
    if (selectedSensors.length === 0) {
      res.status(404).json({ error: `No active sensors for ${dataType} within ${radiusKm}km` });
      return;
    }

    const customer  = extractPayer(req);
    const timestamp = Math.floor(Date.now() / 1000);
    const queryId   = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'bytes32', 'int256', 'int256', 'uint256'],
      [customer, ethers.encodeBytes32String(dataType), Math.round(lat * 1e6), Math.round(lon * 1e6), timestamp],
    ));

    bus.publish({ type: 'query.received', customer, params: { dataType, lat, lon, radiusKm, quorum }, selectedSensorIds: selectedSensors.map((s) => s.sensorId) });

    // ── Step 2: collect readings ──────────────────────────────────────────────
    const readings: SensorReading[] = [];
    const payments: { sensorId: number; wallet: string; amount: number; txHash: string }[] = [];

    await Promise.allSettled(selectedSensors.map(async (sensor) => {
      const queryUrl = `${sensor.endpointUrl}/query?type=${encodeURIComponent(dataType)}`;
      try {
        // Probe for payment requirements
        let requirementOrder: RequirementCandidate[] = [];
        try {
          const probe = await axios.get<Record<string, unknown>>(queryUrl, { validateStatus: (s) => s <= 402 });
          if (probe.status === 402) {
            const candidates = parsePaymentRequiredCandidates(probe);
            requirementOrder = selectRequirementsForAggregator(candidates, arcNetwork);
          } else if (probe.status === 200) {
            const d = probe.data;
            readings.push({ sensorId: sensor.sensorId, sensorWallet: sensor.wallet, value: d['value'] as number, timestamp: d['timestamp'] as number, signature: d['signature'] as string, dataType, unit: d['unit'] as string });
            return;
          }
        } catch { /* probe failed — try direct request */ }

        if (requirementOrder.length > 0) {
          for (const [idx, selectedRequirement] of requirementOrder.entries()) {
            try {
              const created = await evmClientScheme.createPaymentPayload(
                selectedRequirement.x402Version,
                selectedRequirement.requirement as unknown as Parameters<CompositeEvmScheme['createPaymentPayload']>[1],
              );
              const payload = buildPaymentPayloadEnvelope(selectedRequirement, created);
              const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

              const paidResp = await axios.get<Record<string, unknown>>(queryUrl, {
                headers: { 'PAYMENT-SIGNATURE': paymentHeader },
                validateStatus: (s) => s < 500,
              });
              if (paidResp.status !== 200) {
                console.warn(`Sensor ${sensor.sensorId}: payment option ${idx + 1}/${requirementOrder.length} returned ${paidResp.status}`);
                continue;
              }

              const d = paidResp.data;
              readings.push({ sensorId: sensor.sensorId, sensorWallet: sensor.wallet, value: d['value'] as number, timestamp: d['timestamp'] as number, signature: d['signature'] as string, dataType, unit: d['unit'] as string });

              // x402 settlement already paid the operator; record the settlement reference.
              const txHash = extractSettlementTransaction(paidResp.headers as unknown as Record<string, unknown>);
              payments.push({ sensorId: sensor.sensorId, wallet: sensor.wallet, amount: sensor.ratePerQuery, txHash });
              bus.publish({ type: 'query.sensor_payment', sensorId: sensor.sensorId, wallet: sensor.wallet, amount: sensor.ratePerQuery, txHash });
              return;
            } catch {
              // Move to the next requirement option if this payment attempt fails.
            }
          }
          console.warn(`Sensor ${sensor.sensorId}: all payment options failed`);
          return;
        }

        const resp = await axios.get<Record<string, unknown>>(queryUrl, { validateStatus: (s) => s < 500 });
        if (resp.status !== 200) { console.warn(`Sensor ${sensor.sensorId}: ${resp.status}`); return; }

        const d = resp.data;
        readings.push({ sensorId: sensor.sensorId, sensorWallet: sensor.wallet, value: d['value'] as number, timestamp: d['timestamp'] as number, signature: d['signature'] as string, dataType, unit: d['unit'] as string });

      } catch (err) {
        console.error(`Sensor ${sensor.sensorId} failed:`, err);
      }
    }));

    if (readings.length === 0) { res.status(503).json({ error: 'All sensors failed' }); return; }

    // ── Step 3: protocol fee ──────────────────────────────────────────────────
    const actualBase  = payments.reduce((s, p) => s + p.amount, 0);
    const protocolFee = customerPrice - actualBase;
    if (protocolFee > 0) {
      try {
        const txHash = await chain.transferUsdc(deployments.wallets.treasury.address, protocolFee);
        bus.publish({ type: 'query.fee_forwarded', amount: protocolFee, txHash });
      } catch (err) { console.error('Protocol fee failed:', err); }
    }

    // ── Step 4: on-chain record ───────────────────────────────────────────────
    try {
      await chain.recordQuery(customer, payments.map((p) => p.sensorId), payments.map((p) => p.wallet), payments.map((p) => p.amount), protocolFee, queryId);
    } catch (err) { console.error('recordQuery failed:', err); }

    // ── Step 5: verify ───────────────────────────────────────────────────────
    let meta;
    try { meta = await chain.getDataTypeMetadata(dataType); }
    catch { meta = { id: dataType, unit: 'unknown', minValue: -1e9, maxValue: 1e9, expectedVariance: 1 }; }

    const walletMap = new Map<number, string>(selectedSensors.map((s) => [s.sensorId, s.wallet]));
    const result    = verifyReadings(
      readings.map((r) => ({ sensorId: r.sensorId, sensorWallet: r.sensorWallet, value: r.value, timestamp: r.timestamp, signature: r.signature })),
      meta,
      walletMap,
    );

    // ── Step 6: attest ───────────────────────────────────────────────────────
    let attestationId = '';
    try {
      const allReadings = readings.map((r) => ({ sensorId: r.sensorId, sensorWallet: r.sensorWallet, value: r.value, timestamp: r.timestamp, signature: r.signature }));
      attestationId = await postAttestation({ dataType, lat, lon, timestamp }, result, allReadings, chain);
      bus.publish({ type: 'query.attestation_posted', attestationId });
    } catch (err) { console.error('postAttestation failed:', err); }

    // ── Step 7: reputations (fire-and-forget) ────────────────────────────────
    void applyReputationUpdates(result, chain);
    void Promise.allSettled(readings.map((r) => chain.incrementQueryCount(r.sensorId).catch(console.error)));

    // ── Step 8: respond ──────────────────────────────────────────────────────
    const response = {
      verifiedValue:        result.verifiedValue,
      dataType, unit: readings[0]?.unit ?? meta.unit, timestamp, attestationId,
      contributingSensors:  result.accepted.map((r) => r.sensorId),
      excludedSensors:      [...result.outliers, ...result.malformed].map((r) => r.sensorId),
      confidence:           result.confidenceBps / 10000,
      totalPaidUSDC:        (customerPrice / 1e6).toFixed(6),
      operatorEarningsUSDC: (actualBase    / 1e6).toFixed(6),
      protocolFeeUSDC:      (protocolFee   / 1e6).toFixed(6),
      queryId,
    };
    bus.publish({ type: 'query.completed', response });
    res.json(response);
  });

  app.listen(aggregatorPort, () => {
    console.log(`\n✓ Aggregator listening on port ${aggregatorPort}`);
    console.log(`  /readings     → x402-protected (Circle gasless nanopayments active)`);
    console.log(`  /facilitator  → local Arc x402 facilitator`);
    console.log(`\n  Set X402_FACILITATOR_URL=http://localhost:${aggregatorPort}/facilitator in operator .env`);
    console.log(`  Circle Gateway: ${gatewayUrl}`);
  });

  return app;
}
