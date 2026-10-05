import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type Column } from './data-table';
import { applyTable } from './table-logic';

interface Row {
  id: string;
  name: string;
  team: string;
  score: number | null;
}

const ROWS: Row[] = Array.from({ length: 23 }, (_, i) => ({
  id: `r${i + 1}`,
  name: `Person ${String(i + 1).padStart(2, '0')}`,
  team: i % 2 === 0 ? 'Red' : 'Blue',
  score: i === 5 ? null : i,
}));

const COLUMNS: Column<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name, sortValue: (r) => r.name },
  {
    id: 'team',
    header: 'Team',
    cell: (r) => r.team,
    sortValue: (r) => r.team,
    facet: {
      label: 'Team',
      value: (r) => r.team,
      options: [
        { value: 'Red', label: 'Red' },
        { value: 'Blue', label: 'Blue' },
      ],
    },
  },
  { id: 'score', header: 'Score', cell: (r) => String(r.score), sortValue: (r) => r.score },
];

function renderTable(
  rows: Row[] | undefined,
  extra: Partial<React.ComponentProps<typeof DataTable<Row>>> = {},
) {
  return render(
    <DataTable<Row>
      caption="People"
      columns={COLUMNS}
      rows={rows}
      getRowId={(r) => r.id}
      empty={{ title: 'Nobody here yet', hint: 'Add a person.' }}
      {...extra}
    />,
  );
}

const bodyNames = () =>
  within(screen.getAllByRole('rowgroup')[1]!)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]!.textContent);

describe('DataTable (FE-03, one table for every staff list)', () => {
  it('FR-103 FE-03: paginates, shows the range and moves between pages', async () => {
    const u = userEvent.setup();
    renderTable(ROWS);
    expect(bodyNames()).toHaveLength(10);
    expect(screen.getByTestId('table-range')).toHaveTextContent('Showing 1–10 of 23');
    await u.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('table-range')).toHaveTextContent('Showing 11–20 of 23');
    await u.click(screen.getByRole('button', { name: 'Next' }));
    expect(bodyNames()).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await u.selectOptions(screen.getByLabelText('Rows per page'), '25');
    expect(bodyNames()).toHaveLength(23);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  it('FR-103 FE-03: sorts ascending, descending, then clears, and sets aria-sort', async () => {
    const u = userEvent.setup();
    renderTable(ROWS, { defaultPageSize: 25 });
    const header = screen.getByRole('columnheader', { name: /Score/ });
    await u.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()[0]).toBe('Person 01');
    await u.click(within(header).getByRole('button'));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(bodyNames()[0]).toBe('Person 23');
    // The row without a score stays last in both directions.
    expect(bodyNames().at(-1)).toBe('Person 06');
    await u.click(within(header).getByRole('button'));
    expect(header).not.toHaveAttribute('aria-sort');
  });

  it('FR-103 FE-03: the search box and a column filter narrow the rows, and Clear filters resets them', async () => {
    const u = userEvent.setup();
    renderTable(ROWS);
    await u.type(screen.getByLabelText('Search this table'), 'person 07');
    expect(bodyNames()).toEqual(['Person 07']);
    await u.selectOptions(screen.getByLabelText('Team'), 'Blue');
    // Person 07 is on the Red team, so nothing matches both filters.
    expect(screen.getByTestId('table-no-matches')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('table-range')).toHaveTextContent('of 23');
  });

  it('FR-103 FE-03: shows the empty state with its next step when there are no rows', () => {
    renderTable([]);
    expect(screen.getByTestId('table-empty')).toHaveTextContent('Nobody here yet');
    expect(screen.getByTestId('table-empty')).toHaveTextContent('Add a person.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('FR-103 FE-03: shows skeleton rows and a status message while loading', () => {
    renderTable(undefined, { isLoading: true });
    expect(screen.getAllByTestId('table-skeleton-row')).toHaveLength(5);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Loading people');
  });

  it('FR-103 FE-03: shows a fix-it error with a retry button', async () => {
    const onRetry = vi.fn();
    renderTable(undefined, {
      error: { title: 'We could not load people', hint: 'Check your connection.', onRetry },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Check your connection.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('WCAG 2.1 AA: the table has no axe violations', async () => {
    const { container } = renderTable(ROWS);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('applyTable', () => {
  it('FE-03: matches every search word and sorts numbers numerically with nulls last', () => {
    const out = applyTable(ROWS, COLUMNS, {
      search: 'person red',
      facets: {},
      sort: { columnId: 'score', direction: 'desc' },
    });
    // "red" is only in the team column; every word must match somewhere in the row.
    expect(out).toHaveLength(12);
    expect(out[0]?.score).toBe(22);
    const numeric = applyTable(
      [
        { id: 'a', name: 'item 10', team: 'x', score: 1 },
        { id: 'b', name: 'item 9', team: 'x', score: 2 },
      ],
      COLUMNS,
      { search: '', facets: {}, sort: { columnId: 'name', direction: 'asc' } },
    );
    expect(numeric.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
