import type { Column } from './data-table';

export interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface TableQuery {
  search: string;
  facets: Record<string, string>;
  sort: SortState | null;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

function compare(a: string | number | null, b: string | number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Filters (search words, then column facets) and sorts. Pure, so it can be unit tested. */
export function applyTable<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  query: TableQuery,
): T[] {
  const words = query.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let out = rows.filter((row) => {
    for (const c of columns) {
      const wanted = query.facets[c.id];
      if (wanted && c.facet && c.facet.value(row) !== wanted) return false;
    }
    if (words.length === 0) return true;
    const haystack = columns
      .map((c) => c.searchValue?.(row) ?? (c.sortValue ? String(c.sortValue(row) ?? '') : ''))
      .join(' ')
      .toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
  const sortColumn = query.sort ? columns.find((c) => c.id === query.sort?.columnId) : undefined;
  if (query.sort && sortColumn?.sortValue) {
    const sign = query.sort.direction === 'asc' ? 1 : -1;
    const value = sortColumn.sortValue;
    // Array.prototype.sort is stable, so equal rows keep their order.
    out = [...out].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      // Nulls stay last in both directions.
      if (av === null || bv === null) return compare(av, bv);
      return sign * compare(av, bv);
    });
  }
  return out;
}
