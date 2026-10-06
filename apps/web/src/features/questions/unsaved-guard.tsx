'use client';
import { useRouter } from 'next/navigation';
import * as React from 'react';
import { ConfirmDialog } from '@/features/admin/confirm-dialog';

/**
 * Warns before unsaved edits are lost. A reload or tab close gets the browser's own prompt
 * (`beforeunload`). A click on any link inside the app opens a confirm dialog first. The browser
 * Back button cannot be intercepted by the App Router; the reload prompt is the only protection
 * there. Autosave is not part of this step.
 */
export function useUnsavedGuard(dirty: boolean): React.JSX.Element {
  const router = useRouter();
  const [target, setTarget] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => event.preventDefault();
    const onClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!anchor || anchor.getAttribute('target') === '_blank') return;
      const href = anchor.getAttribute('href') ?? '';
      if (!href.startsWith('/') || href.startsWith('//')) return;
      event.preventDefault();
      event.stopPropagation();
      setTarget(href);
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      title="Leave without saving?"
      description="You have unsaved changes to this question. If you leave now they are lost."
      confirmLabel="Leave and discard"
      destructive
      onConfirm={() => {
        const href = target;
        setTarget(null);
        if (href) router.push(href);
      }}
    />
  );
}
