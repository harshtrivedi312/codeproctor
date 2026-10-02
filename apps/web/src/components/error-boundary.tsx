'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';

interface Props {
  children: React.ReactNode;
}
interface State {
  failed: boolean;
}

/** Catches render errors below it. Shows a calm message with a fix-it hint; never prints details. */
export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return <ErrorPanel onRetry={() => this.setState({ failed: false })} />;
  }
}

export function ErrorPanel({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="mx-auto my-16 max-w-md rounded-lg border bg-card p-6 text-center">
      <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your work is not lost. Try again; if it keeps happening, reload the page or check your
        internet connection.
      </p>
      <Button className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
