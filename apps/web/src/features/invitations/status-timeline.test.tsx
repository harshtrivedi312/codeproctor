import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { STATUS_LABEL, StatusTimeline, timelineSteps } from './status-timeline';

const at = (n: number) => new Date(Date.UTC(2026, 5, 1, n)).toISOString();
const hist = (...s: string[]) => s.map((status, i) => ({ status, at: at(i) })) as never;
const states = (items: ReturnType<typeof timelineSteps>) => items.map((i) => `${i.key}:${i.state}`);

describe('FR-303 ADR 0002: the status timeline', () => {
  it('INVITED: the first step is current, the rest are ahead', () => {
    const s = states(timelineSteps('INVITED', hist('INVITED')));
    expect(s[0]).toBe('INVITED:current');
    expect(s.slice(1).every((x) => x.endsWith('upcoming'))).toBe(true);
  });

  it('IN_PROGRESS marks earlier steps done', () => {
    const s = timelineSteps(
      'IN_PROGRESS',
      hist('INVITED', 'OPENED', 'CONSENTED', 'VERIFIED', 'IN_PROGRESS'),
    );
    expect(s.filter((i) => i.state === 'done')).toHaveLength(4);
    expect(s.find((i) => i.state === 'current')?.key).toBe('IN_PROGRESS');
    expect(s.find((i) => i.state === 'done')?.at).toBe(at(0));
  });

  it('PAUSED stays on the taking-the-test step with a note', () => {
    const cur = timelineSteps('PAUSED', hist('INVITED')).find((i) => i.state === 'current');
    expect(cur?.key).toBe('IN_PROGRESS');
    expect(cur?.note).toMatch(/Paused/);
  });

  it('GRADED and UNDER_REVIEW share the in-review step', () => {
    const g = timelineSteps('GRADED', hist('INVITED')).find((i) => i.state === 'current');
    const u = timelineSteps('UNDER_REVIEW', hist('INVITED')).find((i) => i.state === 'current');
    expect(g?.key).toBe(u?.key);
  });

  it('C-28: no step text promises a score before the verdict', () => {
    for (const status of ['SUBMITTED', 'GRADED', 'UNDER_REVIEW'] as const) {
      const text = JSON.stringify(timelineSteps(status, hist('INVITED')));
      expect(text).not.toMatch(/\d+\s?%|score of|flagged/i);
    }
  });

  it('APPEALED completes the review and adds a current appeal step', () => {
    const s = timelineSteps('APPEALED', hist('INVITED'));
    expect(s.find((i) => i.key === 'COMPLETED')?.state).toBe('done');
    expect(s.at(-1)).toMatchObject({ key: 'APPEALED', state: 'current' });
  });

  it('EXPIRED and DECLINED show only what happened, then the end', () => {
    const e = timelineSteps('EXPIRED', hist('INVITED', 'EXPIRED'));
    expect(states(e)).toEqual(['INVITED:done', 'EXPIRED:ended']);
    const d = timelineSteps('DECLINED', hist('INVITED', 'OPENED', 'DECLINED'));
    expect(states(d)).toEqual(['INVITED:done', 'OPENED:done', 'DECLINED:ended']);
  });

  it('D-54 ERASED shows what was reached, then only that the data was erased, with no scores or candidate details', () => {
    const e = timelineSteps(
      'ERASED',
      hist('INVITED', 'OPENED', 'CONSENTED', 'COMPLETED', 'ERASED'),
    );
    expect(states(e)).toEqual([
      'INVITED:done',
      'OPENED:done',
      'CONSENTED:done',
      'COMPLETED:done',
      'ERASED:ended',
    ]);
    expect(e.at(-1)).toMatchObject({ label: 'Data erased', state: 'ended' });
    expect(STATUS_LABEL.ERASED).toBe('Data erased');
    expect(JSON.stringify(e)).not.toMatch(/\d+\s?%|score of|flagged|@/i);
  });

  it('renders an ordered list with aria-current and text for state, and passes axe', async () => {
    const { container } = render(
      <StatusTimeline
        status="VERIFIED"
        history={hist('INVITED', 'OPENED')}
        label="Progress for Backend"
      />,
    );
    expect(screen.getByRole('list', { name: 'Progress for Backend' })).toBeInTheDocument();
    expect(container.querySelector('[aria-current="step"]')).toHaveTextContent('Ready to start');
    expect(screen.getByText('(current step)')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});
