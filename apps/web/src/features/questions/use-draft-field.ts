'use client';
import * as React from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';
import type { DraftValues } from './draft';

export interface TabProps {
  form: UseFormReturn<DraftValues>;
  /** A read-only view of an older version, or a role without edit rights. */
  readOnly: boolean;
}

/**
 * A whole form value (usually an array) read with `useWatch` and written with one `setValue`.
 * The editor's arrays are small, so replacing them wholesale keeps the code simple and avoids
 * useFieldArray, which owns the `id` key that test cases and variants use themselves.
 */
/** Props of tabs that call the API for the saved question (`null` while it is still unsaved). */
export interface ApiTabProps extends TabProps {
  questionId: string | null;
}

export function useDraftField<K extends keyof DraftValues>(
  form: UseFormReturn<DraftValues>,
  name: K,
): [DraftValues[K], (next: DraftValues[K]) => void] {
  const value = useWatch({ control: form.control, name });
  const set = React.useCallback(
    (next: DraftValues[K]) =>
      form.setValue(name, next as never, {
        shouldDirty: true,
        // After a failed save the errors follow the edit; before it, stay quiet.
        shouldValidate: form.formState.isSubmitted,
      }),
    [form, name],
  );
  return [value, set];
}

/** The first error message under a field path, for text next to a control. */
export function errorAt(form: UseFormReturn<DraftValues>, path: string): string | undefined {
  const parts = path.split('.');
  let node: unknown = form.formState.errors;
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (node && typeof node === 'object' && 'message' in node) {
    const m = (node as { message?: unknown }).message;
    return typeof m === 'string' ? m : undefined;
  }
  return undefined;
}
