import type { KeystrokeRecorder } from '@codeproctor/proctor-sdk';
import type { ProctorUiState } from './controller';

/** What the test screen needs from the proctoring wiring (see controller.ts). */
export interface ProctorBridge {
  state: ProctorUiState;
  shareScreen: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  enterFullscreen: () => Promise<boolean>;
  startRecorders: () => Promise<void>;
  clearNotice: () => void;
  /** The keystroke recorder for the answer editor; null until the session has started. */
  keystrokes: () => KeystrokeRecorder | null;
  /** The candidate's own last-section finish is under way (on) or did not go through (off). */
  setSubmitting: (on: boolean) => void;
}
