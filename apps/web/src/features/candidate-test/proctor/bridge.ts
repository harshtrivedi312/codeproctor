import type { ProctorUiState } from './controller';

/** What the test screen needs from the proctoring wiring (see controller.ts). */
export interface ProctorBridge {
  state: ProctorUiState;
  shareScreen: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  enterFullscreen: () => Promise<boolean>;
  startRecorders: () => Promise<void>;
  clearNotice: () => void;
}
