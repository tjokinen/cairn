/**
 * HTTP server that receives event POSTs from the aggregator and insurance agent,
 * and pushes them onto the internal bus for forwarding to websocket clients.
 */
import express from 'express';
import { bus }  from './bus.js';
import type { BusEvent } from './bus.js';

export function buildHttpServer(): express.Application {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // CORS for local dev — frontend runs on a different port
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Generic event ingestion endpoint — used by aggregator (WP-04) and insurance agent (WP-06)
  app.post('/events', (req, res) => {
    const body = req.body as BusEvent;
    if (!body || typeof body.type !== 'string') {
      res.status(400).json({ error: 'Missing event type' });
      return;
    }
    bus.publish(body);
    res.json({ ok: true });
  });

  // Batch ingestion for replay (WP-09)
  app.post('/events/batch', (req, res) => {
    const events = req.body as BusEvent[];
    if (!Array.isArray(events)) {
      res.status(400).json({ error: 'Expected array of events' });
      return;
    }
    for (const e of events) {
      if (typeof e?.type === 'string') bus.publish(e);
    }
    res.json({ ok: true, count: events.length });
  });

  return app;
}
