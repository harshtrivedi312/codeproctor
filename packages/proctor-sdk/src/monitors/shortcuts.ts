import type { Detector, DetectorContext } from '../core/types';

/** Name of a blocked shortcut such as `Ctrl+Shift+I`, or null when the key press is not one. */
export function blockedShortcut(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
): string | null {
  const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (key === 'F12') return 'F12';
  const mod = e.ctrlKey ? 'Ctrl' : e.metaKey ? 'Meta' : null;
  if (!mod) return null;
  if (e.shiftKey && !e.altKey && ['I', 'J', 'C'].includes(key)) return `${mod}+Shift+${key}`;
  // macOS devtools: Cmd+Option+I/J/C
  if (e.metaKey && e.altKey && !e.shiftKey && ['I', 'J', 'C'].includes(key))
    return `Meta+Alt+${key}`;
  if (!e.shiftKey && !e.altKey && key === 'U') return `${mod}+U`;
  return null;
}

/**
 * FR-603 / FR-610: block F12, Ctrl+Shift+I/J/C and Ctrl+U where the browser lets pages do so.
 * Browsers reserve some shortcuts (and the menu route to devtools cannot be blocked at all), so the
 * devtools heuristic stays on as a second line. Only these combinations are looked at; no other
 * key is read or stored.
 */
export class ShortcutMonitor implements Detector {
  readonly id = 'shortcuts';
  private ctx: DetectorContext | null = null;
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const shortcut = blockedShortcut(e);
    if (!shortcut || !this.ctx) return;
    e.preventDefault();
    e.stopPropagation();
    const ctx = this.ctx;
    ctx.measure('shortcuts', () => ctx.emit('SHORTCUT_BLOCKED', { shortcut }));
  };

  constructor(private readonly doc: Document = document) {}

  start(ctx: DetectorContext): void {
    this.ctx = ctx;
    this.doc.addEventListener('keydown', this.onKeyDown, true);
    ctx.setCapability({
      id: 'shortcuts',
      status: 'SUPPORTED',
      detail: 'Best effort: browser-reserved shortcuts and the browser menu cannot be blocked.',
    });
  }

  stop(): void {
    this.doc.removeEventListener('keydown', this.onKeyDown, true);
    this.ctx = null;
  }
}
