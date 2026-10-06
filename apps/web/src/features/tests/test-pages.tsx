'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ApiFailure } from '@/features/admin/queries';
import { useAuth } from '@/features/auth/auth-provider';
import { RequireRole } from '@/features/auth/require-role';
import { can, rolesWith } from '@/features/staff/permissions';
import { fromDetail } from './draft';
import { useTest } from './queries';
import { TestBuilder } from './test-builder';

function Loading(): React.JSX.Element {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading the test…
    </p>
  );
}

function LoadError({ error }: { error: unknown }): React.JSX.Element {
  // 400 is a malformed id in the address (for example a hand-edited ?from=).
  const gone = error instanceof ApiFailure && (error.status === 404 || error.status === 400);
  return (
    <Alert
      tone="error"
      role="alert"
      title={gone ? 'This test does not exist' : 'We could not load this test'}
    >
      {gone
        ? 'It may have been removed or belong to another organisation. '
        : 'Check your connection and reload the page. '}
      <Link href="/admin/tests" className="font-medium text-primary underline underline-offset-4">
        Back to the tests
      </Link>
    </Alert>
  );
}

/** /admin/tests/new, optionally prefilled from `?from=<test id>` (an id, never a name or a person). */
export function NewTestRoute(): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('test:create')}>
      <NewTest />
    </RequireRole>
  );
}

function NewTest(): React.JSX.Element {
  const from = useSearchParams().get('from');
  const source = useTest(from);
  if (from && source.isPending) return <Loading />;
  if (from && source.isError) return <LoadError error={source.error} />;
  const template = source.data
    ? { ...fromDetail(source.data), name: `${source.data.name} (copy)` }
    : undefined;
  return <TestBuilder key={from ?? 'blank'} mode="create" {...(template ? { template } : {})} />;
}

/** /admin/tests/[id]: the builder for a test nobody was invited to, a read-only view otherwise. */
export function TestRoute({ id }: { id: string }): React.JSX.Element {
  return (
    <RequireRole roles={rolesWith('test:read')}>
      <TestLoader id={id} />
    </RequireRole>
  );
}

function TestLoader({ id }: { id: string }): React.JSX.Element {
  // Re-renders when the user or role changes: the provider has cleared the cache by then.
  const { role } = useAuth();
  const test = useTest(id);
  if (test.isPending) return <Loading />;
  if (test.isError) return <LoadError error={test.error} />;
  const mayEdit = can(role, 'test:update') && !test.data.used;
  return (
    <>
      <p className="mb-3 text-sm">
        <Link href="/admin/tests" className="text-primary underline underline-offset-4">
          Back to the tests
        </Link>
      </p>
      <TestBuilder key={id} mode={mayEdit ? 'edit' : 'view'} detail={test.data} />
    </>
  );
}

export function NewTestButton(): React.JSX.Element | null {
  const { role } = useAuth();
  if (!can(role, 'test:create')) return null;
  return (
    <Button asChild>
      <Link href="/admin/tests/new">New test</Link>
    </Button>
  );
}
