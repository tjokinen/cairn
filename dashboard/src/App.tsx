import React, { useReducer, useCallback, useState } from 'react';
import PanelA   from './PanelA';
import PanelB   from './PanelB';
import PanelC   from './PanelC';
import PanelD   from './PanelD';
import PitchDeck from './PitchDeck';
import { initState, reduce } from './store';
import { useDemoPlayer } from './useDemoPlayer';
import type { PlaybackSpeed } from './useDemoPlayer';
import type { BusEvent } from './types';

const DEMO_MODE = !!(import.meta as unknown as { env: Record<string, string> }).env?.['VITE_DEMO_MODE']
  || typeof window !== 'undefined' && !window.location.hostname.includes('localhost');

const WS_URL = (import.meta as unknown as { env: Record<string, string> }).env?.['VITE_WS_URL'] ?? 'ws://localhost:5002';
const RECONNECT_MS = 2000;

// ── Live WebSocket mode ───────────────────────────────────────────────────────

function useLiveWs(dispatch: (e: BusEvent) => void) {
  const wsRef = React.useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    ws.onopen  = () => { setConnected(true); dispatch({ type: 'replay.mode', active: false }); };
    ws.onclose = () => { setConnected(false); setTimeout(connect, RECONNECT_MS); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { payload: BusEvent };
        dispatch(msg.payload);
      } catch { /* ignore */ }
    };
  }, [dispatch]);

  React.useEffect(() => {
    connect();
    return () => wsRef.current?.close();
  }, [connect]);

  return connected;
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reduce, undefined, initState);
  const [pitchMode, setPitchMode] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(5);

  // P key toggles pitch mode
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.key === 'p' || e.key === 'P') && !(e.target instanceof HTMLInputElement)) {
        setPitchMode(m => !m);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Demo or live mode
  const demo = useDemoPlayer(
    DEMO_MODE ? { dispatch, speed } : { dispatch: () => {}, speed }
  );
  const liveConnected = useLiveWs(DEMO_MODE ? () => {} : dispatch);

  const isConnected = DEMO_MODE ? demo.playing : liveConnected;
  const hasSlash    = state.slashEvents.length > 0;

  const SPEEDS: PlaybackSpeed[] = [1, 2, 5, 10, 20];

  return (
    <div className="w-screen h-screen bg-surface overflow-hidden flex flex-col" style={{ fontFamily: 'ui-monospace, monospace' }}>
      {/* Scripted demo banner */}
      {DEMO_MODE && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/30 px-4 py-1.5 text-xs text-yellow-300 flex items-center justify-between shrink-0">
          <span>⚠ SCRIPTED DEMO — synthetic data replay. Not connected to live sensors.</span>
          <div className="flex items-center gap-3">
            <span className="text-yellow-500">Speed:</span>
            {SPEEDS.map(s => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
                  speed === s
                    ? 'bg-yellow-500/30 text-yellow-200 border border-yellow-500/50'
                    : 'text-yellow-500 hover:text-yellow-300'
                }`}
              >
                {s}×
              </button>
            ))}
            <button
              onClick={demo.restart}
              className="px-2 py-0.5 rounded text-xs text-yellow-500 hover:text-yellow-300 border border-yellow-500/30 hover:border-yellow-400/50 transition-colors"
            >
              ↺ Restart
            </button>
            <div className="w-24 h-1 bg-yellow-900/40 rounded overflow-hidden">
              <div
                className="h-full bg-yellow-500/60 transition-all duration-300"
                style={{ width: `${demo.progress * 100}%` }}
              />
            </div>
          </div>
        </div>
      )}

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
          {!DEMO_MODE && (
            <div className="flex items-center gap-1.5 text-xs">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
              <span className={isConnected ? 'text-gray-400' : 'text-red-400'}>{isConnected ? 'Live' : 'Connecting…'}</span>
            </div>
          )}
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
        <div className="min-h-0 overflow-hidden" style={{ gridRow: hasSlash ? '1 / span 2' : '1' }}>
          <PanelA sensors={state.sensors} />
        </div>

        <div className="min-h-0 overflow-hidden" style={{ gridRow: hasSlash ? '1 / span 2' : '1' }}>
          <PanelB
            events={state.txEvents}
            totalTxCount={state.totalTxCount}
            totalSettlements={state.totalSettlements}
            operatorEarnings={state.operatorEarnings}
            protocolTreasury={state.protocolTreasury}
          />
        </div>

        <div className="min-h-0 overflow-hidden">
          <PanelC policy={state.policy} />
        </div>

        {hasSlash && (
          <div className="min-h-0 overflow-hidden">
            <PanelD slashEvents={state.slashEvents} sensors={state.sensors} />
          </div>
        )}
      </main>

      {pitchMode && <PitchDeck onClose={() => setPitchMode(false)} />}
    </div>
  );
}
