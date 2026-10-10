import type { Detector, DetectorContext } from '../core/types';

const VIRTUAL_CAMERA_PATTERNS: readonly RegExp[] = [
  /\bobs\b/i,
  /obs[- ]virtual/i,
  /manycam/i,
  /snap camera/i,
  /xsplit/i,
  /camtwist/i,
  /virtual\s*(cam|camera|webcam)/i,
  /\bndi\b/i,
  /vmix/i,
  /splitcam/i,
  /chromacam/i,
  /e2esoft/i,
  /webcamoid/i,
  /mmhmm/i,
  /streamlabs/i,
];

export interface DeviceLike {
  kind: string;
  label: string;
}

/** Label of the first virtual-camera-looking video input, or null. Labels are untrusted text. */
export function findVirtualCamera(devices: readonly DeviceLike[]): string | null {
  for (const d of devices) {
    if (d.kind !== 'videoinput') continue;
    if (VIRTUAL_CAMERA_PATTERNS.some((p) => p.test(d.label))) return d.label.slice(0, 128);
  }
  return null;
}

export type VirtualCameraCheck =
  | { kind: 'CLEAN' }
  | { kind: 'VIRTUAL'; label: string }
  /** Browsers hide device labels until camera permission is granted; then we cannot know. */
  | { kind: 'LABELS_HIDDEN' }
  | { kind: 'UNSUPPORTED' };

/** The pure part: classify an already enumerated device list. */
export function classifyCameras(devices: readonly DeviceLike[]): VirtualCameraCheck {
  const cams = devices.filter((d) => d.kind === 'videoinput');
  if (cams.length > 0 && cams.every((d) => d.label === '')) return { kind: 'LABELS_HIDDEN' };
  const label = findVirtualCamera(cams);
  return label ? { kind: 'VIRTUAL', label } : { kind: 'CLEAN' };
}

export async function checkVirtualCamera(
  media: Pick<MediaDevices, 'enumerateDevices'> | undefined,
): Promise<VirtualCameraCheck> {
  if (!media || typeof media.enumerateDevices !== 'function') return { kind: 'UNSUPPORTED' };
  return classifyCameras(await media.enumerateDevices());
}

/**
 * FR-610 / TC-064: device-name check on start and whenever devices change. A renamed virtual
 * camera passes; this is evidence, not proof. enumerateDevices never prompts, but needs the camera
 * permission to show labels, so before the system check grants it we report LABELS_HIDDEN honestly.
 */
export class VirtualCameraMonitor implements Detector {
  readonly id = 'virtual-camera';
  readonly accommodationId = 'VIRTUAL_CAMERA' as const;
  private reported = new Set<string>();
  private ctx: DetectorContext | null = null;
  private readonly onChange = (): void => void this.run();

  constructor(
    private readonly media:
      | Pick<MediaDevices, 'enumerateDevices' | 'addEventListener' | 'removeEventListener'>
      | undefined = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices,
  ) {}

  /** Re-run after the camera permission is granted so hidden labels become readable. */
  async run(): Promise<VirtualCameraCheck | null> {
    const ctx = this.ctx;
    if (!ctx) return null;
    let r: VirtualCameraCheck;
    try {
      r = await checkVirtualCamera(this.media);
    } catch {
      r = { kind: 'UNSUPPORTED' };
    }
    if (!this.ctx) return r;
    ctx.measure('virtual-camera', () => {
      if (r.kind === 'VIRTUAL') {
        ctx.setCapability({ id: 'virtual-camera', status: 'SUPPORTED' });
        if (!this.reported.has(r.label)) {
          this.reported.add(r.label);
          ctx.emit('VIRTUAL_CAMERA', { deviceLabel: r.label });
        }
      } else if (r.kind === 'CLEAN') {
        ctx.setCapability({ id: 'virtual-camera', status: 'SUPPORTED' });
      } else {
        ctx.setCapability({
          id: 'virtual-camera',
          status: r.kind === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'UNVERIFIABLE',
          detail:
            r.kind === 'LABELS_HIDDEN'
              ? 'Camera labels are hidden until camera permission is granted.'
              : 'enumerateDevices is not available.',
        });
        if (!this.reported.has(r.kind)) {
          this.reported.add(r.kind);
          ctx.emit('DETECTOR_UNAVAILABLE', {
            detector: 'VIRTUAL_CAMERA',
            reason: r.kind === 'UNSUPPORTED' ? 'UNSUPPORTED' : 'PERMISSION_DENIED',
          });
        }
      }
    });
    return r;
  }

  async start(ctx: DetectorContext): Promise<void> {
    this.ctx = ctx;
    this.media?.addEventListener?.('devicechange', this.onChange);
    await this.run();
  }

  stop(): void {
    this.media?.removeEventListener?.('devicechange', this.onChange);
    this.ctx = null;
  }
}
