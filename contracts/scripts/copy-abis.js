#!/usr/bin/env node
// Copies compiled ABIs from contracts/out/ to common/src/abis/ after forge build.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_ROOT = resolve(__dirname, '..');
const COMMON_ABIS    = resolve(CONTRACTS_ROOT, '..', 'common', 'src', 'abis');

const CONTRACTS = [
  'DataTypeRegistry',
  'SensorRegistry',
  'CairnAggregator',
  'CairnAttestation',
];

if (!existsSync(COMMON_ABIS)) {
  mkdirSync(COMMON_ABIS, { recursive: true });
}

for (const name of CONTRACTS) {
  const artifactPath = resolve(CONTRACTS_ROOT, 'out', `${name}.sol`, `${name}.json`);
  if (!existsSync(artifactPath)) {
    console.error(`Missing artifact: ${artifactPath}. Run forge build first.`);
    process.exit(1);
  }

  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const abiPath  = resolve(COMMON_ABIS, `${name}.json`);
  writeFileSync(abiPath, JSON.stringify(artifact.abi, null, 2));
  console.log(`Copied ${name}.json → common/src/abis/`);
}
