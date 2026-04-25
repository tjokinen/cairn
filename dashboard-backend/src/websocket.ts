/**
 * Single WebSocket channel streaming all bus events to connected frontend clients.
 * Message format: { type, timestamp, payload }
 */
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage }       from 'http';
import { bus }                        from './bus.js';
import type { BusEvent }              from './bus.js';

export interface WsMessage {
  type:      string;
  timestamp: number;
  payload:   BusEvent;
}

export function startWebSocketServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    console.log(`[WS] Client connected from ${ip} (total: ${wss.clients.size})`);

    ws.on('close', () => {
      console.log(`[WS] Client disconnected (total: ${wss.clients.size})`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  // Broadcast every bus event to all connected clients
  bus.on('event', (payload: BusEvent) => {
    const msg: WsMessage = {
      type:      payload.type,
      timestamp: Date.now(),
      payload,
    };
    const data = JSON.stringify(msg);

    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  });

  wss.on('listening', () => {
    console.log(`[WS] WebSocket server listening on port ${port}`);
  });

  return wss;
}
