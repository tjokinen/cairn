import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { Deployments } from './types.js';

export function loadDeployments(repoRoot?: string): Deployments {
  const root = repoRoot ?? resolve(process.cwd());
  const path = resolve(root, 'deployments.json');
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as Deployments;
}
