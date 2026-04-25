import { readFileSync } from 'fs';
import { resolve } from 'path';

export interface OperatorConfig {
  name: string;
  walletId: string;
  location: { lat: number; lon: number };
  dataTypes: string[];
  ratePerQuery: number;   // USDC smallest units (100 = $0.0001)
  accuracy: { noiseStddev: number; biasOffset: number };
  port: number;
  adminEnabled: boolean;
}

export function loadConfig(path: string): OperatorConfig {
  const raw = readFileSync(resolve(path), 'utf8');
  // Expand ${VAR_NAME} placeholders from environment
  const expanded = raw.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
  const cfg = JSON.parse(expanded) as OperatorConfig;

  if (!cfg.name)        throw new Error('config: missing name');
  if (!cfg.walletId)    throw new Error('config: missing walletId');
  if (!cfg.dataTypes?.length) throw new Error('config: missing dataTypes');
  if (!cfg.port)        throw new Error('config: missing port');

  cfg.accuracy ??= { noiseStddev: 0, biasOffset: 0 };
  cfg.adminEnabled ??= false;
  return cfg;
}
