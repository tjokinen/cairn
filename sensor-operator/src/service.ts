import 'dotenv/config';
import express from 'express';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { GatewayEvmScheme, BatchFacilitatorClient } from '@circle-fin/x402-batching/server';
import { HTTPFacilitatorClient } from '@x402/core/server';
import type { FacilitatorClient } from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from '@x402/core/types';

import { loadConfig }           from './config.js';
import { loadState, saveState } from './state.js';
import { RegistryClient }       from './registry.js';
import { ReadingSigner }        from './signer.js';
import { OpenWeatherMapSource } from './sources/openweathermap.js';
import { SyntheticSource }      from './sources/synthetic.js';
import { loadDeployments }      from '@cairn/common';
import type { OperatorState }   from './state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..', '..');

function buildArcFacilitatorClient(arcNetwork: Network, facilitatorUrl: string): FacilitatorClient {
  const httpFacilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

  return {
    verify(payment: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
      return httpFacilitator.verify(payment, requirements);
    },
    settle(payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
      return httpFacilitator.settle(payment, requirements);
    },
    // Keep startup deterministic even if the HTTP facilitator is not reachable yet.
    async getSupported() {
      return {
        kinds: [{ x402Version: 2, scheme: 'exact', network: arcNetwork }],
        extensions: [],
        signers: {},
      };
    },
  };
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

// ── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: tsx src/service.ts <config-path>');
    process.exit(1);
  }

  const config      = loadConfig(configPath);
  const deployments = loadDeployments(REPO_ROOT);
  const statePath   = resolve(__dirname, '..', 'state', `${config.name}.json`);
  let state: OperatorState = loadState(statePath);

  console.log(`\n=== Cairn Sensor Operator: ${config.name} ===`);
  console.log(`  Port:      ${config.port}`);
  console.log(`  DataTypes: ${config.dataTypes.join(', ')}`);
  console.log(`  Rate:      ${config.ratePerQuery} USDC units ($${(config.ratePerQuery / 1e6).toFixed(6)})`);

  // ── Get wallet address ────────────────────────────────────────────────────
  const registry = new RegistryClient(deployments);
  const walletAddress = await registry.getWalletAddress(config.walletId);
  console.log(`  Wallet:    ${walletAddress}`);

  // ── Register on-chain (idempotent) ────────────────────────────────────────
  if (state.sensorId == null) {
    console.log('\nRegistering sensor on-chain...');
    await registry.ensureApproval(config.walletId);
    const sensorId = await registry.register(config.walletId, config);
    state = { sensorId, registeredAt: Math.floor(Date.now() / 1000), totalEarnings: 0 };
    saveState(statePath, state);
    console.log(`  ✓ Registered as sensorId = ${sensorId}`);
  } else {
    console.log(`\nAlready registered as sensorId = ${state.sensorId}`);
  }

  const sensorId = state.sensorId!;
  const signer   = new ReadingSigner();

  // ── Data sources ──────────────────────────────────────────────────────────
  const owm = new OpenWeatherMapSource(
    config.location.lat,
    config.location.lon,
    config.accuracy.noiseStddev,
  );
  const synthetic = new SyntheticSource();
  owm.start();

  let biasOffset = config.accuracy.biasOffset;

  function getValue(dataType: string): number | null {
    if (owm.supports(dataType))       return owm.getValue(dataType);
    if (synthetic.supports(dataType)) return synthetic.getValue(dataType);
    return null;
  }

  function getUnit(dataType: string): string {
    const units: Record<string, string> = {
      'weather.temperature_c':       'degC',
      'weather.humidity_pct':        'pct',
      'weather.precipitation_mm_h':  'mm/h',
      'weather.wind_ms':             'm/s',
      'air.pm25_ugm3':               'ug/m3',
      'air.pm10_ugm3':               'ug/m3',
      'seismic.velocity_mms':        'mm/s',
      'radiation.dose_usvh':         'uSv/h',
    };
    return units[dataType] ?? 'unknown';
  }

  // ── x402 resource server ──────────────────────────────────────────────────
  const arcNetwork = `eip155:${deployments.arcChainId}` as Network;
  const defaultFacilitatorUrl = `http://localhost:${process.env.AGGREGATOR_PORT ?? '4000'}/facilitator`;
  const defaultGatewayUrl = 'https://gateway-api-testnet.circle.com/gateway';
  const facilitatorUrl = (process.env.X402_FACILITATOR_URL?.trim() || defaultFacilitatorUrl).replace(/\/+$/, '');
  const gatewayUrl = (process.env.CIRCLE_GATEWAY_URL?.trim() || defaultGatewayUrl).replace(/\/+$/, '');
  const facilitator = [
    // Circle Gateway facilitator for gas-free nanopayment compatibility.
    buildGatewayFacilitatorClient(gatewayUrl),
    // Local Arc facilitator fallback if Gateway is unavailable.
    buildArcFacilitatorClient(arcNetwork, facilitatorUrl),
  ];
  console.log(`  x402 facilitator: ${facilitatorUrl}`);
  console.log(`  Circle nanopayments: enabled (${gatewayUrl})`);

  const evmScheme = new GatewayEvmScheme();
  // Ensure Arc USDC address resolution for both onchain exact and Gateway-compatible requirements.
  evmScheme.registerMoneyParser(async (amountDecimal, network) => {
    if (network !== arcNetwork) return null;
    const smallestUnits = Math.round(amountDecimal * 1_000_000).toString();
    return {
      amount: smallestUnits,
      asset:  process.env.USDC_ADDRESS ?? '0x3600000000000000000000000000000000000000',
    };
  });

  const resourceServer = new x402ResourceServer(facilitator)
    .register(arcNetwork, evmScheme);

  const priceUSD = `$${(config.ratePerQuery / 1_000_000).toFixed(7)}`;

  // ── Express app ───────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  // GET /info — public
  app.get('/info', (_req, res) => {
    res.json({
      name:         config.name,
      sensorId,
      location:     config.location,
      dataTypes:    config.dataTypes,
      ratePerQuery: config.ratePerQuery,
      walletAddress,
      active:       true,
    });
  });

  // GET /earnings — public
  app.get('/earnings', (_req, res) => {
    res.json({
      totalEarnings:      state.totalEarnings,
      totalEarningsUSDC:  (state.totalEarnings / 1e6).toFixed(6),
    });
  });

  // POST /admin/set-bias — only when adminEnabled
  app.post('/admin/set-bias', (req, res) => {
    if (!config.adminEnabled) {
      res.status(403).json({ error: 'Admin endpoints not enabled for this operator' });
      return;
    }
    const { offset } = req.body as { offset?: number };
    if (typeof offset !== 'number') {
      res.status(400).json({ error: 'offset must be a number' });
      return;
    }
    biasOffset = offset;
    owm.setBiasOffset(offset);
    console.log(`[ADMIN] Bias offset set to ${offset} for ${config.name}`);
    res.json({ ok: true, biasOffset });
  });

  // GET /query — x402-protected
  app.use(
    paymentMiddleware(
      {
        'GET /query': {
          accepts: {
            scheme:  'exact',
            price:   priceUSD,
            network: arcNetwork,
            payTo:   walletAddress,
            // EIP-712 domain params for Arc USDC — required for local facilitator signing
            extra:   { name: 'USD Coin', version: '2' },
          },
          description: `Sensor reading from ${config.name}`,
        },
      },
      resourceServer,
    ),
  );

  app.get('/query', async (req, res) => {
    const dataType = req.query['type'] as string;

    if (!dataType) {
      res.status(400).json({ error: 'Missing ?type=<dataType>' });
      return;
    }
    if (!config.dataTypes.includes(dataType)) {
      res.status(404).json({ error: `Data type ${dataType} not supported by this operator` });
      return;
    }

    const value = getValue(dataType);
    if (value === null) {
      res.status(503).json({ error: 'No data available yet — sensor still initializing' });
      return;
    }

    const timestamp = Math.floor(Date.now() / 1000);

    try {
      const signature = await signer.sign(config.walletId, sensorId, value, timestamp);

      // Track earnings
      state.totalEarnings += config.ratePerQuery;
      saveState(statePath, state);

      res.json({
        sensorId,
        dataType,
        value,
        unit:      getUnit(dataType),
        timestamp,
        signature,
      });
    } catch (err) {
      console.error('Failed to sign reading:', err);
      res.status(500).json({ error: 'Signing failed' });
    }
  });

  app.listen(config.port, () => {
    console.log(`\n✓ ${config.name} listening on port ${config.port}`);
    console.log(`  /info     → public`);
    console.log(`  /query    → x402-protected (${priceUSD} per query)`);
    console.log(`  /earnings → public`);
    if (config.adminEnabled) {
      console.log(`  /admin/set-bias → enabled`);
    }
  });
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
