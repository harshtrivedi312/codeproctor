import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  emptyQuestion,
  emptySection,
  fromDetail,
  moveItem,
  parseTags,
  testDraftSchema,
  toBody,
  totalPoints,
  limitsTotal,
  type PickableQuestion,
  type TestDraft,
} from './draft';

const pickable: PickableQuestion[] = [
  { type: 'CODING', tags: ['arrays', 'sorting'], difficulty: 'MEDIUM' },
  { type: 'CODING', tags: ['arrays'], difficulty: 'EASY' },
  { type: 'MCQ', tags: ['complexity'], difficulty: 'MEDIUM' },
];

function draft(patch: Partial<TestDraft> = {}): TestDraft {
  const q = {
    ...emptyQuestion('fixed'),
    versionId: 'v1',
    title: 'Two sum',
    difficulty: 'EASY' as const,
  };
  return {
    ...emptyDraft(),
    name: 'A test',
    sections: [{ ...emptySection('One'), questions: [q] }],
    ...patch,
  };
}
const issues = (d: TestDraft, p: PickableQuestion[] | null = pickable) => {
  const r = testDraftSchema(p).safeParse(d);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('test builder rules (FR-301, FR-302, ADR 0002)', () => {
  it('FR-301: a valid draft has no issue', () => {
    expect(issues(draft())).toEqual([]);
  });

  it('FR-301 ADR 0002: section time limits may not add up to more than the duration', () => {
    const d = draft({
      durationMinutes: 60,
      sections: [
        { ...emptySection('A'), timeLimit: '40', questions: draft().sections[0]!.questions },
        {
          ...emptySection('B'),
          timeLimit: '30',
          questions: [{ ...emptyQuestion('fixed'), versionId: 'v2' }],
        },
      ],
    });
    expect(limitsTotal(d.sections)).toBe(70);
    expect(issues(d).join(' ')).toMatch(
      /durationMinutes: The section time limits add up to 70 minutes, more than the 60 minute duration/,
    );
    expect(issues({ ...d, durationMinutes: 70 })).toEqual([]);
  });

  it('FR-301: a limit is a whole number of minutes or empty; the duration is 5 to 480', () => {
    const q = draft().sections[0]!.questions;
    expect(
      issues(draft({ sections: [{ ...emptySection('A'), timeLimit: '1.5', questions: q }] })).join(
        ' ',
      ),
    ).toMatch(/timeLimit: Use a whole number/);
    expect(
      issues(draft({ sections: [{ ...emptySection('A'), timeLimit: '0', questions: q }] })).join(
        ' ',
      ),
    ).toMatch(/timeLimit/);
    expect(issues(draft({ durationMinutes: 4 })).join(' ')).toMatch(/At least 5 minutes/);
    expect(issues(draft({ durationMinutes: 481 })).join(' ')).toMatch(/At most 480 minutes/);
    expect(issues(draft({ durationMinutes: 5 }))).toEqual([]);
    expect(issues(draft({ durationMinutes: 480 }))).toEqual([]);
  });

  it('FR-301: every section needs a name and at least one question; a fixed row needs a pick', () => {
    expect(
      issues(
        draft({ sections: [{ ...emptySection(''), questions: draft().sections[0]!.questions }] }),
      ).join(' '),
    ).toMatch(/Name this section/);
    expect(issues(draft({ sections: [emptySection('Empty')] })).join(' ')).toMatch(
      /Add at least one question to this section/,
    );
    expect(
      issues(
        draft({ sections: [{ ...emptySection('A'), questions: [emptyQuestion('fixed')] }] }),
      ).join(' '),
    ).toMatch(/Pick a question/);
    expect(issues(draft({ sections: [] })).join(' ')).toMatch(/Add at least one section/);
  });

  it('FR-301: the pass score is from 0 to the points of all questions together, with 2 decimals', () => {
    const d = draft();
    expect(totalPoints(d.sections)).toBe(100);
    expect(issues({ ...d, passScore: '100' })).toEqual([]);
    expect(issues({ ...d, passScore: '0' })).toEqual([]);
    expect(issues({ ...d, passScore: '100.01' }).join(' ')).toMatch(
      /cannot be more than the 100 points/,
    );
    expect(issues({ ...d, passScore: '-1' }).join(' ')).toMatch(/Use a number from 0/);
    expect(issues({ ...d, passScore: '50.123' }).join(' ')).toMatch(/at most 2 decimals/);
    expect(issues({ ...d, passScore: 'abc' }).join(' ')).toMatch(/Use a number/);
    const two = draft({
      sections: [
        {
          ...emptySection('A'),
          questions: [
            { ...emptyQuestion('fixed'), versionId: 'a', points: 40.5 },
            { ...emptyQuestion('random'), points: 10.25 },
          ],
        },
      ],
    });
    expect(totalPoints(two.sections)).toBe(50.75);
    expect(issues({ ...two, passScore: '50.75' }, null)).toEqual([]);
    expect(issues({ ...two, passScore: '50.76' }, null).join(' ')).toMatch(/50.75 points/);
  });

  it('FR-301: points are above 0 with at most 2 decimals', () => {
    const row = (points: number) =>
      draft({
        sections: [
          {
            ...emptySection('A'),
            questions: [{ ...emptyQuestion('fixed'), versionId: 'a', points }],
          },
        ],
      });
    expect(issues(row(0)).join(' ')).toMatch(/above 0/);
    expect(issues(row(0.001)).join(' ')).toMatch(/at most 2 decimals/);
    expect(issues(row(10000)).join(' ')).toMatch(/more than 9999.99/);
    expect(issues(row(Number.NaN)).join(' ')).toMatch(/Enter the points/);
    expect(issues(row(0.01))).toEqual([]);
  });

  it('TC-020 FR-301: a random rule has valid tags and enough different matching published questions (N slots need N)', () => {
    const rnd = (tagsText: string, extra: Partial<ReturnType<typeof emptyQuestion>> = {}) => ({
      ...emptyQuestion('random'),
      tagsText,
      ...extra,
    });
    const withRows = (...rows: ReturnType<typeof rnd>[]) =>
      draft({ sections: [{ ...emptySection('A'), questions: rows }] });
    expect(issues(withRows(rnd('arrays')))).toEqual([]);
    expect(issues(withRows(rnd('')))).toEqual([]); // any question
    expect(issues(withRows(rnd('Bad Tag!'))).join(' ')).toMatch(/"bad tag!" is not a valid tag/);
    expect(
      issues(withRows(rnd(Array.from({ length: 21 }, (_, i) => `t${i}`).join(',')))).join(' '),
    ).toMatch(/at most 20 tags/);
    // Two published questions have the tag arrays; three slots with it need three.
    expect(issues(withRows(rnd('arrays'), rnd('arrays'), rnd('arrays'))).join(' ')).toMatch(
      /Only 2 published questions match this rule, and the test needs 3 different ones/,
    );
    expect(issues(withRows(rnd('arrays'), rnd('arrays')))).toEqual([]);
    // Difficulty and type narrow the match; an impossible rule is refused.
    expect(issues(withRows(rnd('arrays', { ruleDifficulty: 'HARD' }))).join(' ')).toMatch(
      /Only 0 published questions match/,
    );
    expect(issues(withRows(rnd('', { ruleType: 'MCQ' })))).toEqual([]);
    // Different rules are counted apart; unknown availability (still loading) blocks nothing.
    expect(
      issues(
        withRows(
          rnd('arrays', { ruleDifficulty: 'MEDIUM' }),
          rnd('arrays', { ruleDifficulty: 'EASY' }),
        ),
      ),
    ).toEqual([]);
    expect(issues(withRows(rnd('arrays', { ruleDifficulty: 'HARD' })), null)).toEqual([]);
  });

  it('FR-301: the request body numbers positions from 1, carries fixed versions or rules, and no count', () => {
    const d = draft({
      description: ' text ',
      passScore: '80',
      profile: 'STRICT',
      sections: [
        {
          ...emptySection(' First '),
          timeLimit: '30',
          questions: [
            { ...emptyQuestion('fixed'), versionId: 'v-1', points: 20 },
            {
              ...emptyQuestion('random'),
              tagsText: ' Arrays , SORTING ',
              ruleDifficulty: 'MEDIUM',
              points: 60,
            },
          ],
        },
        { ...emptySection('Second'), questions: [{ ...emptyQuestion('random'), points: 10 }] },
      ],
    });
    const body = toBody(d);
    expect(body).toMatchObject({
      name: 'A test',
      description: ' text ',
      durationMinutes: 60,
      profile: 'STRICT',
      passScore: 80,
    });
    expect(body.sections).toEqual([
      {
        title: 'First',
        position: 1,
        timeLimitMin: 30,
        questions: [
          { position: 1, points: 20, questionVersionId: 'v-1' },
          {
            position: 2,
            points: 60,
            randomRule: { tags: ['arrays', 'sorting'], difficulty: 'MEDIUM' },
          },
        ],
      },
      { title: 'Second', position: 2, questions: [{ position: 1, points: 10, randomRule: {} }] },
    ]);
    expect(JSON.stringify(body)).not.toContain('count');
    // No description and no pass score are left out, not sent empty.
    const bare = toBody(draft());
    expect(bare).not.toHaveProperty('description');
    expect(bare).not.toHaveProperty('passScore');
  });

  it('FR-301: moveItem reorders without touching the rest and ignores impossible moves', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('FR-301: tags are trimmed, lower-cased and de-duplicated like the API does', () => {
    expect(parseTags(' Arrays, sorting ,arrays,, ')).toEqual(['arrays', 'sorting']);
  });

  it('FR-301: a test loaded from the API becomes a draft and back to the same body', () => {
    const detail = {
      id: 't',
      name: 'N',
      description: 'D',
      durationMinutes: 45,
      profile: 'STANDARD',
      passScore: 10,
      createdById: null,
      createdAt: '2026-01-01T00:00:00Z',
      sectionCount: 2,
      questionCount: 2,
      used: false,
      sections: [
        {
          id: 's2',
          title: 'Two',
          position: 2,
          timeLimitMin: null,
          questions: [
            {
              id: 'q',
              position: 1,
              points: 5,
              questionVersionId: null,
              title: null,
              difficulty: null,
              randomRule: { tags: ['a'] },
            },
          ],
        },
        {
          id: 's1',
          title: 'One',
          position: 1,
          timeLimitMin: 20,
          questions: [
            {
              id: 'p',
              position: 1,
              points: 5,
              questionVersionId: 'v',
              title: 'T',
              difficulty: 'EASY',
              randomRule: null,
            },
          ],
        },
      ],
    } as Parameters<typeof fromDetail>[0];
    const d = fromDetail(detail);
    expect(d.sections.map((s) => s.title)).toEqual(['One', 'Two']);
    expect(toBody(d).sections.map((s) => s.questions[0])).toEqual([
      { position: 1, points: 5, questionVersionId: 'v' },
      { position: 1, points: 5, randomRule: { tags: ['a'] } },
    ]);
  });
});
