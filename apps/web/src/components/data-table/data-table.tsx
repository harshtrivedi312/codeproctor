'use client';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import * as React from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { applyTable, pageCount, type SortState } from './table-logic';

export interface Column<T> {
  id: string;
  header: string;
  /** Cell content. */
  cell: (row: T) => React.ReactNode;
  /** Makes the column sortable. Null values sort last. */
  sortValue?: (row: T) => string | number | null;
  /** Text matched by the search box. Defaults to the sort value. */
  searchValue?: (row: T) => string;
  /** Adds a drop-down filter for this column. */
  facet?: { label: string; value: (row: T) => string; options: { value: string; label: string }[] };
  className?: string;
}

export interface DataTableProps<T> {
  /** Names the table for screen readers and is shown above it. */
  caption: string;
  columns: readonly Column<T>[];
  /** Undefined while loading. */
  rows: readonly T[] | undefined;
  getRowId: (row: T) => string;
  isLoading?: boolean;
  /** Shown instead of the table when the data could not be loaded. */
  error?: { title: string; hint: string; onRetry?: () => void } | null;
  /** Shown when there are no rows at all (not when a filter hides them). */
  empty: { title: string; hint?: string; action?: React.ReactNode };
  searchLabel?: string;
  pageSizes?: readonly number[];
  defaultPageSize?: number;
  defaultSort?: SortState;
  /** Extra controls (for example an Invite button) on the right of the filter bar. */
  toolbar?: React.ReactNode;
}

const SKELETON_ROWS = 5;

/**
 * The one table of the staff app: sorting, a search box, optional column filters, pagination, and
 * loading, error and empty states. Client-side only; the lists in this step are small. When a list
 * can grow past a few thousand rows, switch this to server-side paging behind the same props.
 */
export function DataTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  isLoading = false,
  error = null,
  empty,
  searchLabel = 'Search this table',
  pageSizes = [10, 25, 50],
  defaultPageSize = 10,
  defaultSort,
  toolbar,
}: DataTableProps<T>): React.JSX.Element {
  const baseId = React.useId();
  const [search, setSearch] = React.useState('');
  const [facets, setFacets] = React.useState<Record<string, string>>({});
  const [sort, setSort] = React.useState<SortState | null>(defaultSort ?? null);
  const [pageSize, setPageSize] = React.useState(defaultPageSize);
  const [page, setPage] = React.useState(0);

  const view = React.useMemo(
    () => applyTable(rows ?? [], columns, { search, facets, sort }),
    [rows, columns, search, facets, sort],
  );
  const pages = pageCount(view.length, pageSize);
  const safePage = Math.min(page, pages - 1);
  const start = safePage * pageSize;
  const visible = view.slice(start, start + pageSize);
  const facetColumns = columns.filter((c) => c.facet);
  const filtered = search.trim() !== '' || Object.values(facets).some((v) => v !== '');
  const loading = isLoading || (rows === undefined && !error);

  function toggleSort(columnId: string): void {
    setPage(0);
    setSort((current) => {
      if (current?.columnId !== columnId) return { columnId, direction: 'asc' };
      if (current.direction === 'asc') return { columnId, direction: 'desc' };
      return null;
    });
  }
  function clearFilters(): void {
    setSearch('');
    setFacets({});
    setPage(0);
  }

  if (error) {
    return (
      <Alert tone="error" role="alert" title={error.title}>
        <p>{error.hint}</p>
        {error.onRetry ? (
          <Button className="mt-2" size="sm" variant="outline" onClick={error.onRetry}>
            Try again
          </Button>
        ) : null}
      </Alert>
    );
  }

  const noRowsAtAll = !loading && (rows?.length ?? 0) === 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-base font-semibold" id={`${baseId}-caption`}>
          {caption}
        </h2>
        <div className="flex flex-wrap items-end gap-2">
          {!noRowsAtAll ? (
            <>
              <div>
                <label htmlFor={`${baseId}-search`} className="sr-only">
                  {searchLabel}
                </label>
                <Input
                  id={`${baseId}-search`}
                  type="search"
                  className="h-9 w-56"
                  placeholder="Search…"
                  value={search}
                  disabled={loading}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                />
              </div>
              {facetColumns.map((c) => (
                <div key={c.id}>
                  <label htmlFor={`${baseId}-facet-${c.id}`} className="sr-only">
                    {c.facet!.label}
                  </label>
                  <select
                    id={`${baseId}-facet-${c.id}`}
                    className="h-9 rounded-md border border-input bg-card px-2 text-sm"
                    value={facets[c.id] ?? ''}
                    disabled={loading}
                    onChange={(e) => {
                      setFacets((f) => ({ ...f, [c.id]: e.target.value }));
                      setPage(0);
                    }}
                  >
                    <option value="">{c.facet!.label}: all</option>
                    {c.facet!.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </>
          ) : null}
          {noRowsAtAll && empty.action ? null : toolbar}
        </div>
      </div>

      {noRowsAtAll ? (
        <div
          className="rounded-md border border-dashed bg-card p-8 text-center"
          data-testid="table-empty"
        >
          <p className="font-medium">{empty.title}</p>
          {empty.hint ? <p className="mt-1 text-sm text-muted-foreground">{empty.hint}</p> : null}
          {empty.action ? <div className="mt-3">{empty.action}</div> : null}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table
            className="w-full border-collapse text-left text-sm"
            aria-labelledby={`${baseId}-caption`}
            aria-busy={loading}
          >
            <thead className="border-b bg-muted/60">
              <tr>
                {columns.map((c) => {
                  const sorted = sort?.columnId === c.id ? sort.direction : null;
                  return (
                    <th
                      key={c.id}
                      scope="col"
                      className={cn('px-3 py-2 font-medium', c.className)}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : undefined
                      }
                    >
                      {c.sortValue ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded hover:underline"
                          onClick={() => toggleSort(c.id)}
                        >
                          {c.header}
                          {sorted === 'asc' ? (
                            <ArrowUp className="size-3.5" aria-hidden="true" />
                          ) : sorted === 'desc' ? (
                            <ArrowDown className="size-3.5" aria-hidden="true" />
                          ) : (
                            <ArrowUpDown className="size-3.5 opacity-50" aria-hidden="true" />
                          )}
                          <span className="sr-only">
                            {sorted === 'asc'
                              ? ', sorted ascending, activate to sort descending'
                              : sorted === 'desc'
                                ? ', sorted descending, activate to clear sorting'
                                : ', activate to sort ascending'}
                          </span>
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                    <tr key={i} className="border-b last:border-0" data-testid="table-skeleton-row">
                      {columns.map((c) => (
                        <td key={c.id} className="px-3 py-2">
                          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
                        </td>
                      ))}
                    </tr>
                  ))
                : visible.map((row) => (
                    <tr key={getRowId(row)} className="border-b last:border-0 hover:bg-muted/40">
                      {columns.map((c) => (
                        <td key={c.id} className={cn('px-3 py-1.5 align-middle', c.className)}>
                          {c.cell(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
              {!loading && view.length === 0 ? (
                <tr data-testid="table-no-matches">
                  <td colSpan={columns.length} className="px-3 py-6 text-center">
                    <p>No rows match your filters.</p>
                    {filtered ? (
                      <Button className="mt-2" size="sm" variant="outline" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {loading ? (
        <p role="status" className="sr-only">
          Loading {caption.toLowerCase()}…
        </p>
      ) : null}

      {!loading && !noRowsAtAll ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p aria-live="polite" data-testid="table-range">
            {view.length === 0
              ? 'No rows'
              : `Showing ${start + 1}–${start + visible.length} of ${view.length}`}
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor={`${baseId}-size`} className="text-muted-foreground">
              Rows per page
            </label>
            <select
              id={`${baseId}-size`}
              className="h-9 rounded-md border border-input bg-card px-2"
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </Button>
            <span aria-hidden="true">
              {safePage + 1} / {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={safePage >= pages - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
