import type { Detector, DetectorContext } from '../core/types';

/**
 * FR-603: block paste, copy, cut, drop and the context menu inside the test root and log each
 * attempt. Only the size of the clipboard or drop content is sent, never the content.
 */
export class ClipboardMonitor implements Detector {
  readonly id = 'clipboard';
  private ctx: DetectorContext | null = null;
  private root: HTMLElement | null = null;

  private readonly onPaste = (e: Event): void => {
    const text = (e as ClipboardEvent).clipboardData?.getData('text/plain');
    this.block(e, 'PASTE_ATTEMPT', text?.length);
  };
  private readonly onCopy = (e: Event): void =>
    this.block(e, 'COPY_ATTEMPT', this.selectionLength());
  private readonly onCut = (e: Event): void => this.block(e, 'CUT_ATTEMPT', this.selectionLength());
  private readonly onDrop = (e: Event): void => {
    const text = (e as DragEvent).dataTransfer?.getData('text/plain');
    this.block(e, 'DROP_ATTEMPT', text?.length);
  };
  private readonly onDragOver = (e: Event): void => e.preventDefault();
  private readonly onContextMenu = (e: Event): void => this.block(e, 'RIGHT_CLICK');

  private selectionLength(): number | undefined {
    return this.root?.ownerDocument.getSelection()?.toString().length;
  }

  private block(
    e: Event,
    type: 'PASTE_ATTEMPT' | 'COPY_ATTEMPT' | 'CUT_ATTEMPT' | 'DROP_ATTEMPT' | 'RIGHT_CLICK',
    length?: number,
  ): void {
    e.preventDefault();
    e.stopPropagation();
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.measure('clipboard', () => {
      if (type === 'RIGHT_CLICK') ctx.emit('RIGHT_CLICK', {});
      else ctx.emit(type, length === undefined ? {} : { length });
    });
  }

  start(ctx: DetectorContext): void {
    this.ctx = ctx;
    this.root = ctx.root;
    const r = ctx.root;
    // Capture phase so an editor (Monaco) that handles paste itself never sees the event.
    r.addEventListener('paste', this.onPaste, true);
    r.addEventListener('copy', this.onCopy, true);
    r.addEventListener('cut', this.onCut, true);
    r.addEventListener('drop', this.onDrop, true);
    r.addEventListener('dragover', this.onDragOver, true);
    r.addEventListener('contextmenu', this.onContextMenu, true);
    ctx.setCapability({ id: 'clipboard', status: 'SUPPORTED' });
  }

  stop(): void {
    const r = this.root;
    if (r) {
      r.removeEventListener('paste', this.onPaste, true);
      r.removeEventListener('copy', this.onCopy, true);
      r.removeEventListener('cut', this.onCut, true);
      r.removeEventListener('drop', this.onDrop, true);
      r.removeEventListener('dragover', this.onDragOver, true);
      r.removeEventListener('contextmenu', this.onContextMenu, true);
    }
    this.ctx = null;
    this.root = null;
  }
}
