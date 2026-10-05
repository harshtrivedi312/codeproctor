import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * Resolves once a DataTable has left its loading state (not aria-busy, skeleton rows gone) or
 * shows its empty state. Waits for that state, not for a fixed time, so a slow CI runner cannot
 * time a test out while the table was still loading. The long limit is only a safety net (it
 * needs `testTimeout` in vitest.config.mts to be higher still). Returning on the empty state is
 * safe: DataTable shows it only after a load finished with no rows, and an error renders an alert
 * with no table, so the helper keeps waiting and fails.
 */
export async function findLoadedTable(): Promise<void> {
  await waitFor(
    () => {
      if (screen.queryByTestId('table-empty')) return;
      expect(screen.getByRole('table')).not.toHaveAttribute('aria-busy', 'true');
      expect(screen.queryAllByTestId('table-skeleton-row')).toHaveLength(0);
    },
    { timeout: 20_000 },
  );
}

/** Waits for the loaded table, then finds the row whose accessible name matches. */
export async function findLoadedRow(name: string | RegExp): Promise<HTMLElement> {
  await findLoadedTable();
  return screen.findByRole('row', { name: typeof name === 'string' ? new RegExp(name) : name });
}
