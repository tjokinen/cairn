import React, { useReducer, useEffect, useCallback, useState, useRef } from 'react';
import PanelA   from './PanelA';
import PanelB   from './PanelB';
import PanelC   from './PanelC';
import PanelD   from './PanelD';
import PitchDeck from './PitchDeck';
import { initState, reduce } from './store';
import type { WsMessage } from './types';

const WS_URL = (import.meta as unknown as { env: Record<string, string> }).env?.['VITE_WS_URL'] ?? 'ws://localhost:5002';
const RECONNECT_MS = 2000;

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initState);
  const [pitchMode, setPitchMode] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      dispatch({ type: 'replay.mode', active: false });
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        dispatch(msg.payload);
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      setTimeout(connect, RECONNECT_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();
    return () => { wsRef.current?.close(); };
  }, [connect]);

  // Track WS connected status
  useEffect(() => {
    const interval = setInterval(() => {
      const connected = wsRef.current?.readyState === WebSocket.OPEN;
      if (connected !== state.wsConnected) {
        // We can't dispatch this from here without causing reducer loops, so we
        // show a simple indicator derived from the ws ref directly.
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [state.wsConnected]);

  // P key toggles pitch mode
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === 'p' || e.key === 'P') && !(e.target instanceof HTMLInputElement)) {
        setPitchMode(m => !m);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isConnected = wsRef.current?.readyState === WebSocket.OPEN;
  const hasSlash    = state.slashEvents.length > 0;

  return (
    <div className="w-screen h-screen bg-surface overflow-hidden flex flex-col" style={{ fontFamily: 'ui-monospace, monospace' }}>
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-white font-bold tracking-tight">⛰ Cairn</span>
          <span className="text-gray-600 text-xs">Oracle Network Dashboard</span>
        </div>
        <div className="flex items-center gap-4">
          {state.replayMode && (
            <span className="text-xs px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 animate-pulse font-semibold">
              ⏪ REPLAY MODE
            </span>
          )}
          <div className="flex items-center gap-1.5 text-xs">
            <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
            <span className={isConnected ? 'text-gray-400' : 'text-red-400'}>{isConnected ? 'Live' : 'Connecting…'}</span>
          </div>
          <button
            onClick={() => setPitchMode(true)}
            className="text-xs px-2 py-1 rounded bg-border text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Press P for pitch deck"
          >
            [P] Pitch
          </button>
        </div>
      </header>

      {/* Main grid: A(map) | B(tx stream) | C(policy) [+ D(slash) stacked below C] */}
      <main
        className="flex-1 grid gap-2 p-2 overflow-hidden"
        style={{
          gridTemplateColumns: '2fr 2fr 1.2fr',
          gridTemplateRows: hasSlash ? '1fr 1fr' : '1fr',
        }}
      >
        {/* Panel A — Sensor map, full height */}
        <div className="min-h-0 overflow-hidden" style={{ gridRow: hasSlash ? '1 / span 2' : '1' }}>
          <PanelA sensors={state.sensors} />
        </div>

        {/* Panel B — Transaction stream, full height */}
        <div className="min-h-0 overflow-hidden" style={{ gridRow: hasSlash ? '1 / span 2' : '1' }}>
          <PanelB
            events={state.txEvents}
            totalTxCount={state.totalTxCount}
            totalSettlements={state.totalSettlements}
            operatorEarnings={state.operatorEarnings}
            protocolTreasury={state.protocolTreasury}
          />
        </div>

        {/* Panel C — Active policy (top-right) */}
        <div className="min-h-0 overflow-hidden">
          <PanelC policy={state.policy} />
        </div>

        {/* Panel D — Slashing feed (bottom-right, only when slash occurred) */}
        {hasSlash && (
          <div className="min-h-0 overflow-hidden">
            <PanelD slashEvents={state.slashEvents} sensors={state.sensors} />
          </div>
        )}
      </main>

      {/* Pitch deck overlay */}
      {pitchMode && <PitchDeck onClose={() => setPitchMode(false)} />}
    </div>
  );
}
