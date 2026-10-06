/*
 * Keeps track of the Monaco instance so the models of question code (starter code, reference
 * solutions, AI solutions) can be disposed when the editor closes or the signed-in user changes.
 * Monaco keeps one model per path for the life of the page; without this, another question's or
 * another user's solution would stay in memory. This file does not import Monaco, so the lazy
 * loading of the editor is not defeated. Every question model path starts with `q/`.
 */

export const MODEL_ROOT = 'q/';

export interface ModelHost {
  editor: { getModels(): { uri: { path: string }; dispose(): void }[] };
}

let host: ModelHost | null = null;

/** Called by the Monaco wrapper once Monaco has loaded. */
export function registerModelHost(h: ModelHost): void {
  host = h;
}

/**
 * Disposes every model whose path (Monaco puts a leading slash on it) contains the prefix.
 * No Monaco yet means nothing to dispose. Returns how many models were disposed.
 */
export function disposeModels(prefix: string): number {
  if (!host) return 0;
  const needle = `/${prefix}`;
  const models = host.editor.getModels().filter((m) => m.uri.path.includes(needle));
  for (const m of models) m.dispose();
  return models.length;
}

/** Test-only: forget the host. */
export function resetModelHostForTests(): void {
  host = null;
}
