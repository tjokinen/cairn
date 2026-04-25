# Cairn

Nanopayment oracle protocol for community-operated sensor networks. Built for the Agentic Economy on Arc hackathon.

---

## How to run bootstrap

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
- `CIRCLE_ENTITY_SECRET` — generated in Circle Console (Entity Secret for developer-controlled wallets)
- `CIRCLE_WALLET_SET_ID` — create a Wallet Set in Circle Console and paste the ID
- `CIRCLE_GATEWAY_URL` — Circle Gateway base URL for nanopayments (default testnet: `https://gateway-api-testnet.circle.com/gateway`)
- `DEPLOYER_PRIVATE_KEY` — a funded Arc testnet wallet private key for contract deployment. Generate one and fund it from [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet)
- `OPENWEATHERMAP_API_KEY` — from OpenWeatherMap dashboard

### Step 3 — Build contracts

```bash
cd contracts && forge build && cd ..
```

### Step 4 — Run bootstrap

```bash
npm run bootstrap
```

This will:
1. Create 9 Circle Wallets (treasury, aggregator, policyholder, customer, operator1–5)
2. Print all wallet addresses and **pause** — fund each from [faucet.circle.com](https://faucet.circle.com) (select Arc Testnet, 20 USDC per address per 2h), then press Enter
3. Deploy all four Cairn contracts to Arc testnet in dependency order
4. Write `deployments.json` to the repo root

**Expected runtime:** < 5 minutes. Total < 10 minutes if faucet is slow.

### Step 5 — Verify

Open `deployments.json` and confirm four contract addresses are present. Check each on the [Arc testnet explorer](https://testnet.arcscan.app).

---

## Running the demo

```bash
# Honest scenario (5 operators, insurance payout triggered by real weather data)
npm run demo:honest

# Adversarial scenario (Operator 5 goes rogue, gets slashed, honest quorum still pays out)
npm run demo:adversarial

# Reset all state and redeploy
npm run demo:reset
```

All x402 payment paths in the demo are configured to actively prefer Circle Gateway gasless nanopayments on Arc testnet, and buyers automatically retry compatible Arc exact payment options from the same `402` response if the preferred Gateway option is unavailable.

---

## Architecture

See `PLAN.md` for full system architecture, data flow, and work package specifications.
