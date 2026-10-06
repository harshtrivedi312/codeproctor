import type { SystemCheckBody } from '@/features/candidate-flow/wire';
import type { BrowserInfo, ScreenShareKind } from './checks';
import type { MultiScreenResult } from '@codeproctor/proctor-sdk';

export interface CollectedChecks {
  browser: BrowserInfo;
  cameraOk: boolean;
  microphoneOk: boolean;
  screen: ScreenShareKind | null;
  network: { downlinkKbps: number; rttMs: number } | null;
  monitor: MultiScreenResult | null;
  virtualCameraLabel: string | null;
}

/** Builds the ADR 0013 section 5.4 body. Sends no identifiers: the session comes from the token. */
export function buildSystemCheckBody(c: CollectedChecks, now: Date = new Date()): SystemCheckBody {
  const findings: SystemCheckBody['findings'] = [];
  if (c.monitor?.kind === 'MULTI') {
    findings.push({
      type: 'MULTI_MONITOR',
      occurredAt: now.toISOString(),
      payload:
        c.monitor.screenCount === undefined
          ? { api: c.monitor.api }
          : { api: c.monitor.api, screenCount: c.monitor.screenCount },
    });
  }
  if (c.virtualCameraLabel) {
    findings.push({
      type: 'VIRTUAL_CAMERA',
      occurredAt: now.toISOString(),
      payload: { deviceLabel: c.virtualCameraLabel.slice(0, 128) },
    });
  }
  const capabilities: SystemCheckBody['capabilities'] = [
    { id: 'record-webcam', status: c.cameraOk ? 'SUPPORTED' : 'DENIED' },
    { id: 'record-audio', status: c.microphoneOk ? 'SUPPORTED' : 'DENIED' },
    {
      id: 'screen-share',
      status:
        c.screen === 'MONITOR'
          ? 'SUPPORTED'
          : c.screen === 'UNVERIFIABLE'
            ? 'UNVERIFIABLE'
            : 'DENIED',
    },
  ];
  if (c.monitor) {
    capabilities.push({
      id: 'multi-screen',
      status:
        c.monitor.kind === 'UNSUPPORTED'
          ? 'UNSUPPORTED'
          : c.monitor.kind === 'DENIED'
            ? 'DENIED'
            : 'SUPPORTED',
    });
  }
  return {
    browser: { brand: c.browser.brand, majorVersion: c.browser.majorVersion },
    ...(c.network ? { network: c.network } : {}),
    devices: {
      camera: c.cameraOk,
      microphone: c.microphoneOk,
      screenShare: c.screen ?? 'OTHER',
    },
    findings,
    capabilities,
  };
}
