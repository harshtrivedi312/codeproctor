'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { DEMO_API_BASE, DEMO_HMAC_KEY_B64, DEMO_MODEL_BASE } from './demo-key';
import { MockServerPanel } from './mock-server-panel';

const SESSION_KEY = 'dev-proctor-session';

/** Stable across reloads of the tab (so TC-063 can resume from IndexedDB), new per tab. */
function demoSessionId(): string {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/** Mounts the framework-agnostic SDK demo and calibration panel (FR-601..610, FR-701, FR-606). */
export function ProctorDemoClient() {
  const demoRef = useRef<HTMLDivElement>(null);
  const calibRef = useRef<HTMLDivElement>(null);
  // sessionStorage only exists in the browser; the server render gets null.
  const sessionId = useSyncExternalStore(
    () => () => undefined,
    demoSessionId,
    () => null,
  );

  useEffect(() => {
    const demoEl = demoRef.current;
    const calibEl = calibRef.current;
    if (!sessionId || !demoEl || !calibEl) return;
    let cancelled = false;
    let stopDemo: (() => Promise<void>) | null = null;
    let stopCalib: (() => void) | null = null;
    void import('@codeproctor/proctor-sdk').then((sdk) => {
      if (cancelled) return;
      const handle = sdk.mountProctorDemo(demoEl, {
        apiBase: DEMO_API_BASE,
        modelBaseUrl: DEMO_MODEL_BASE,
        hmacKeyBase64: DEMO_HMAC_KEY_B64,
        sessionId,
        onStarted: ({ session, vision }) => {
          if (!cancelled) {
            const panel = sdk.mountCalibrationPanel(calibEl, session, vision);
            stopCalib = () => panel.stop();
          }
        },
      });
      stopDemo = () => handle.stop();
    });
    return () => {
      cancelled = true;
      stopCalib?.();
      void stopDemo?.();
    };
  }, [sessionId]);

  return (
    <div className="space-y-6">
      {sessionId && <MockServerPanel sessionId={sessionId} />}
      <div ref={demoRef} />
      <div ref={calibRef} />
    </div>
  );
}
