import { useEffect, useRef, useCallback, useState } from 'react';
import type { BusEvent } from './types';

interface DemoEvent {
  deltaMs: number;
  message: { type: string; timestamp: number; payload: BusEvent };
}

export type PlaybackSpeed = 1 | 2 | 5 | 10 | 20;

interface DemoPlayerOptions {
  dispatch: (event: BusEvent) => void;
  speed: PlaybackSpeed;
}

export function useDemoPlayer({ dispatch, speed }: DemoPlayerOptions) {
  const [loaded, setLoaded]     = useState(false);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const eventsRef  = useRef<DemoEvent[]>([]);
  const indexRef   = useRef(0);
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speedRef   = useRef(speed);
  const dispatchRef = useRef(dispatch);
  speedRef.current  = speed;
  dispatchRef.current = dispatch;

  const stop = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  const scheduleNext = useCallback(() => {
    const events = eventsRef.current;
    const idx    = indexRef.current;
    if (idx >= events.length) {
      setPlaying(false);
      setProgress(1);
      return;
    }
    const delayMs = events[idx].deltaMs / speedRef.current;
    timerRef.current = setTimeout(() => {
      dispatchRef.current(events[idx].message.payload);
      indexRef.current = idx + 1;
      setProgress((idx + 1) / events.length);
      scheduleNext();
    }, Math.max(0, delayMs));
  }, []);

  const startFrom = useCallback((idx: number) => {
    stop();
    indexRef.current = idx;
    setProgress(idx / Math.max(1, eventsRef.current.length));
    setPlaying(true);
    dispatchRef.current({ type: 'replay.mode', active: true });
    scheduleNext();
  }, [stop, scheduleNext]);

  const restart = useCallback(() => startFrom(0), [startFrom]);

  // Load demo.json once on mount
  useEffect(() => {
    fetch('./demo.json')
      .then(r => r.json())
      .then((data: DemoEvent[]) => {
        eventsRef.current = data;
        setLoaded(true);
      })
      .catch(console.error);
  }, []);

  // Auto-start once loaded
  useEffect(() => {
    if (loaded) startFrom(0);
    return stop;
  }, [loaded, startFrom, stop]);

  return { loaded, playing, progress, restart };
}
