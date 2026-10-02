/**
 * Fullscreen lock state (FR-601 UI side, ADR 0002 P-2). Pure reducer, no proctoring logic: the
 * demo only reflects whether the document is fullscreen. A candidate-caused lock makes the editor
 * read-only but never stops the clock.
 */
export type LockPhase = 'gate' | 'running';

export interface LockState {
  phase: LockPhase;
  /** False when the candidate continued without fullscreen (demo only, unsupported browsers). */
  requiresFullscreen: boolean;
  locked: boolean;
  /** True when the lock came from the demo control, not a real fullscreen change. */
  simulated: boolean;
  warnings: number;
}

export type LockEvent =
  | { type: 'start'; fullscreen: boolean }
  | { type: 'fullscreen-exited'; simulated?: boolean }
  | { type: 'fullscreen-restored' };

export const initialLockState: LockState = {
  phase: 'gate',
  requiresFullscreen: true,
  locked: false,
  simulated: false,
  warnings: 0,
};

export function lockReducer(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case 'start':
      return { ...initialLockState, phase: 'running', requiresFullscreen: event.fullscreen };
    case 'fullscreen-exited':
      if (state.phase !== 'running' || state.locked) return state;
      if (!state.requiresFullscreen && !event.simulated) return state;
      return {
        ...state,
        locked: true,
        simulated: event.simulated === true,
        warnings: state.warnings + 1,
      };
    case 'fullscreen-restored':
      return state.locked ? { ...state, locked: false, simulated: false } : state;
  }
}

export const isEditorReadOnly = (s: LockState, timeExpired: boolean): boolean =>
  s.phase !== 'running' || s.locked || timeExpired;
