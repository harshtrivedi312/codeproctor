'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DIFFICULTY_LABEL, TYPE_LABEL } from '@/features/questions/labels';
import type { QuestionSummary } from '@/features/questions/queries';

/** A published question a test can use as a fixed pick: its PUBLISHED version id is what the API takes. */
export interface PickRow {
  versionId: string;
  title: string;
  type: QuestionSummary['type'];
  difficulty: NonNullable<QuestionSummary['published']>['difficulty'];
  tags: string[];
}

export function pickRows(questions: readonly QuestionSummary[] | undefined): PickRow[] {
  return (questions ?? []).flatMap((q) =>
    q.published && !q.isArchived
      ? [
          {
            versionId: q.published.id,
            title: q.published.title,
            type: q.type,
            difficulty: q.published.difficulty,
            tags: q.tags,
          },
        ]
      : [],
  );
}

export function QuestionPicker({
  open,
  onClose,
  rows,
  taken,
  loading,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  rows: readonly PickRow[];
  /** Version ids already in this test: a question is not used twice. */
  taken: ReadonlySet<string>;
  loading: boolean;
  onPick: (row: PickRow) => void;
}): React.JSX.Element {
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('');
  const [difficulty, setDifficulty] = React.useState('');
  const shown = rows.filter(
    (r) =>
      (type === '' || r.type === type) &&
      (difficulty === '' || r.difficulty === difficulty) &&
      `${r.title} ${r.tags.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <DialogTitle>Add a question from the bank</DialogTitle>
        <DialogDescription>
          Only published questions can be used. A test keeps the published version you pick, even if
          the question is edited later.
        </DialogDescription>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            aria-label="Search questions by title or tag"
            placeholder="Search by title or tag"
            className="w-64"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select
            aria-label="Filter by type"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
          >
            <option value="">Any difficulty</option>
            {Object.entries(DIFFICULTY_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        {loading ? (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            Loading the questions…
          </p>
        ) : shown.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {rows.length === 0
              ? 'There are no published questions yet. An author publishes them in the question bank.'
              : 'No published question matches these filters.'}
          </p>
        ) : (
          <ul className="mt-4 divide-y rounded-md border">
            {shown.map((r) => (
              <li
                key={r.versionId}
                className="flex flex-wrap items-center justify-between gap-2 p-3"
              >
                <div>
                  <p className="font-medium">{r.title}</p>
                  <p className="text-sm text-muted-foreground">
                    {TYPE_LABEL[r.type]} · {DIFFICULTY_LABEL[r.difficulty]}
                    {r.tags.length > 0 ? ` · ${r.tags.join(', ')}` : ''}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={taken.has(r.versionId)}
                  aria-label={`${taken.has(r.versionId) ? 'Already added' : 'Add'} ${r.title}`}
                  onClick={() => onPick(r)}
                >
                  {taken.has(r.versionId) ? 'Already added' : 'Add'}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
