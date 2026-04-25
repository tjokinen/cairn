import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

export interface OperatorState {
  sensorId: number | null;
  registeredAt: number | null;
  totalEarnings: number;   // USDC smallest units, cumulative
}

const DEFAULT: OperatorState = { sensorId: null, registeredAt: null, totalEarnings: 0 };

export function loadState(statePath: string): OperatorState {
  if (!existsSync(statePath)) return { ...DEFAULT };
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as OperatorState;
  } catch {
    return { ...DEFAULT };
  }
}

export function saveState(statePath: string, state: OperatorState): void {
  const dir = dirname(resolve(statePath));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
