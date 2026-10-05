export * from './core/types';
export * from './core/canonical';
export * from './core/hmac';
export * from './core/idb';
export * from './core/event-queue';
export * from './core/heartbeat';
export * from './core/metrics';
export * from './core/transport';
export * from './core/session';
export * from './monitors/fullscreen';
export * from './monitors/visibility';
export * from './monitors/clipboard';
export * from './monitors/shortcuts';
export * from './monitors/devtools';
export * from './monitors/multi-screen';
export * from './monitors/virtual-camera';
export * from './monitors/screen-share';

import { ClipboardMonitor } from './monitors/clipboard';
import { DevtoolsMonitor } from './monitors/devtools';
import { FullscreenMonitor } from './monitors/fullscreen';
import { MultiScreenMonitor } from './monitors/multi-screen';
import { ScreenShareMonitor } from './monitors/screen-share';
import { ShortcutMonitor } from './monitors/shortcuts';
import { VirtualCameraMonitor } from './monitors/virtual-camera';
import { VisibilityMonitor } from './monitors/visibility';

/** The standard monitor set. The UI keeps the fullscreen and screen-share instances to call enter() and request(). */
export function createDefaultMonitors() {
  return {
    fullscreen: new FullscreenMonitor(),
    visibility: new VisibilityMonitor(),
    clipboard: new ClipboardMonitor(),
    shortcuts: new ShortcutMonitor(),
    devtools: new DevtoolsMonitor(),
    multiScreen: new MultiScreenMonitor(),
    virtualCamera: new VirtualCameraMonitor(),
    screenShare: new ScreenShareMonitor(),
  };
}
export { mountProctorDemo, type DemoHandle, type DemoOptions } from './demo/mount';

export * from './recording/types';
export * from './recording/upload-queue';
export * from './recording/recorder';
export * from './recording/media-api';
export * from './recording/pipeline';

export * from './detectors/config';
export * from './detectors/rules';
export * from './detectors/protocol';
export * from './detectors/inference-client';
export * from './detectors/default-worker';
export * from './detectors/evidence';
export * from './detectors/identity';
export * from './detectors/voice-monitor';
export * from './detectors/vision-monitor';
export { mountCalibrationPanel } from './demo/calibration';
