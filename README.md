# Cairn

Nanopayment oracle protocol for community-operated sensor networks. Built for the [Agentic Economy on Arc](https://arc.network) hackathon.

Sensor operators register data feeds, post a USDC stake, and serve readings via [x402](https://x402.org) endpoints. Customer agents — parametric insurance contracts, climate risk monitors, automated research agents — discover and purchase verified readings per-query, settled as USDC nanopayments on Arc.

**[Live demo →](https://cairn-aggregator.vercel.app/)**  *(scripted replay, no live sensors required)*

---

## Architecture

```
Customer Agent          Cairn Aggregator         Sensor Operators (×N)      Treasury
──────────────          ────────────────         ─────────────────────      ────────
     │  GET /readings         │                          │                      │
     │ ──────────────────────▶│                          │                      │
     │  402 Payment Required  │                          │                      │
     │ ◀──────────────────────│                          │                      │
     │  EIP-3009 auth         │                          │                      │
     │ ──────────────────────▶│                          │                      │
     │                        │  GET /query (x402)       │                      │
     │                        │ ────────────────────────▶│                      │
     │                        │  Reading + signature     │                      │
     │                        │ ◀────────────────────────│                      │
     │                        │  Forward 2% fee                                 │
     │                        │ ───────────────────────────────────────────────▶│
     │  200 OK                │  recordQuery + postAttestation + updateReputation│
     │  { verifiedValue,      │  (on-chain, Arc testnet)                        │
     │    attestationId, … }  │                                                 │
     │ ◀──────────────────────│                                                 │
```

Operators receive 100% of their quoted rate. Cairn charges a 2% markup to the customer for discovery, verification, and on-chain attestation.

### On-chain contracts (Arc testnet, Solidity)

| Contract | Role |
|---|---|
| `DataTypeRegistry` | Canonical metadata for registered data types (weather, air, seismic, radiation) |
| `SensorRegistry` | Operator identity, rates, stake, and reputation; slashes stake automatically when reputation falls below threshold |
| `CairnAggregator` | Event-emitting audit contract; records every query's fee accounting on-chain |
| `CairnAttestation` | Immutable verification record per query; referenced by customer agents as audit trail |

### Off-chain services

- **Sensor operator** — x402-gated reading endpoint; one instance per operator (ports 3001–3005 in demo)
- **Cairn aggregator** — x402 resource server; orchestrates discovery, nanopayments, verification, and on-chain writes
- **Insurance agent** — customer-side demo agent; streams premium, buys readings, triggers payout on breach
- **Dashboard backend** — indexes on-chain events and forwards them to the frontend via WebSocket
- **Dashboard** — React frontend with live sensor map, transaction stream, policy status, and slashing feed

### Verification

Each query collects signed readings from N sensors. The aggregator runs MAD (median absolute deviation) outlier detection: readings more than `2.5 × max(MAD, expectedVariance)` from the median are excluded. The verified value is the median of the accepted set. Outlier sensors receive a negative reputation delta on-chain; honest sensors receive a positive one. Sensors whose reputation falls below 0.30 are automatically slashed (2 USDC per slash) and deactivated if their remaining stake drops below 4 USDC.

### Payment mechanics

Every USDC movement uses **Circle Nanopayments via EIP-3009 Transfer With Authorization**. The payer signs an authorization; Circle validates off-chain and settles on-chain in batches. This makes per-query payments of $0.0001 economically viable — traditional rails (Stripe: $0.30 minimum, L1 gas: $1–5) are 3,000–50,000× the query value.

---

## Demo scenario

The adversarial demo shows the full system end-to-end:

1. Five weather sensor operators register around Colima, Mexico, each backed by real [OpenWeatherMap](https://openweathermap.org) data
2. A parametric insurance agent continuously buys verified temperature readings
3. At T+60s, Operator 5 (Tecomán-02) is injected with a +20°C bias; the honest quorum detects and excludes it each cycle
4. The verified temperature (33.5°C) exceeds the policy threshold for 3 consecutive readings → insurance payout triggered
5. Operator 5's reputation decays over 14 outlier cycles → falls below 0.30 → slashed and deactivated

---

## Running locally

### Prerequisites

| Requirement | Notes |
|---|---|
| Node.js 20 LTS | `node --version` should print `v20.x` |
| npm 10+ | Included with Node 20 |
| Foundry | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| Circle Developer account | Sign up at [developers.circle.com](https://developers.circle.com) |
| OpenWeatherMap API key | Free tier — [openweathermap.org/api](https://openweathermap.org/api) |

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Fill in `.env`:

- `CIRCLE_API_KEY` — from Circle Developer Console
- `CIRCLE_ENTITY_SECRET` — generated in Circle Console
- `CIRCLE_WALLET_SET_ID` — create a Wallet Set in Circle Console and paste the ID
- `DEPLOYER_PRIVATE_KEY` — a funded Arc testnet wallet. Generate one and fund it from [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet)
- `OPENWEATHERMAP_API_KEY` — from OpenWeatherMap dashboard

### Step 3 — Build contracts

```bash
cd contracts && forge build && cd ..
```

### Step 4 — Bootstrap

```bash
npm run bootstrap
```

This creates 9 Circle Wallets (treasury, aggregator, policyholder, customer, operators 1–5), pauses for you to fund each from the faucet, deploys all four contracts, and writes `deployments.json`.

### Step 5 — Run the demo

```bash
# Adversarial scenario: Operator 5 goes rogue, gets slashed, honest quorum pays out
npm run demo:adversarial

# Honest baseline
npm run demo:honest

# Reset all state
npm run demo:reset
```

Open the dashboard at `http://localhost:3000`.

---

## Vercel demo

The dashboard can be deployed to Vercel as a self-contained scripted replay — no live services required.

```bash
# Preview locally
cd dashboard && VITE_DEMO_MODE=1 npm run dev
```

To deploy: push to GitHub and connect the repo to Vercel. The `vercel.json` at the repo root configures the build automatically.

---

## Tech stack

| Layer | Tool |
|---|---|
| Settlement | Arc testnet (EVM L1, USDC-native gas) |
| Payments | Circle Nanopayments (EIP-3009 Transfer With Authorization) |
| Payment protocol | x402 (`@x402/express`, `@x402/client`) |
| Wallet infra | Circle Developer-Controlled Wallets |
| Contracts | Solidity + Foundry |
| Services | TypeScript + Node.js 20 |
| Frontend | React + Tailwind CSS + Recharts |
| Ground-truth data | OpenWeatherMap API (free tier) |
