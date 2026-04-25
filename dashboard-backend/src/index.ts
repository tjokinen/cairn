import 'dotenv/config';
import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import { loadDeployments }  from '@cairn/common';
import { Indexer }          from './indexer.js';
import { buildHttpServer }  from './server.js';
import { startWebSocketServer } from './websocket.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..', '..');

const HTTP_PORT = parseInt(process.env['DASHBOARD_HTTP_PORT'] ?? '5001', 10);
const WS_PORT   = parseInt(process.env['DASHBOARD_WS_PORT']   ?? '5002', 10);

const deployments = loadDeployments(REPO_ROOT);

// Start on-chain event indexer
const indexer = new Indexer(deployments);
await indexer.start();

// Start HTTP server for aggregator / agent event ingestion
const app = buildHttpServer();
app.listen(HTTP_PORT, () => {
  console.log(`\n✓ Dashboard backend HTTP on port ${HTTP_PORT}`);
  console.log(`  POST /events        → ingest aggregator / insurance events`);
  console.log(`  POST /events/batch  → replay batch ingestion`);
});

// Start WebSocket server for frontend
startWebSocketServer(WS_PORT);

// Graceful shutdown
process.on('SIGINT',  () => { indexer.stop(); process.exit(0); });
process.on('SIGTERM', () => { indexer.stop(); process.exit(0); });
