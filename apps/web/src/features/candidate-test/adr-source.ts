import type { Schemas } from '@/lib/api/client';
import { requestAt, type ApiResult } from '@/features/candidate-flow/api';
import {
  RUNNING_STATUSES,
  draftSavedSchema,
  isOverStatus,
  questionViewSchema,
  runResponseSchema,
  sectionFinishAcceptedSchema,
  sessionStateSchema,
  testLayoutSchema,
  type QuestionView,
  type TestLayout,
} from './adr-wire';
import type { TestQuestion, TestSource } from './source';

/**
 * The real test screen's data source on the ADR 0013 routes (PROVISIONAL, see adr-wire.ts). Every
 * call carries the candidate session token from memory (the token is never in a URL), branches on
 * the problem `code`, and reports a 401 through `onSessionEnded` (the candidate opens the link
 * again for a new code; ADR 0013 5.2 401 codes).
 */
export const UNSUPPORTED_QUESTION = 'UNSUPPORTED_QUESTION';

export class TestLoadError extends Error {
  constructor(readonly reason: 'unsupported' | 'unavailable') {
    super(reason);
  }
}

function questionFor(view: QuestionView, points: number): TestQuestion {
  if (view.type === 'SHORT_ANSWER') {
    return {
      id: view.sessionQuestionId,
      type: 'mcq', // the generated shape has no short answer: `format` says what it is
      format: 'short',
      title: view.title,
      points,
      statementMarkdown: view.statementMd,
      options: [],
      saved: view.saved,
    };
  }
  if (view.type === 'MCQ') {
    return {
      id: view.sessionQuestionId,
      type: 'mcq',
      title: view.title,
      points,
      statementMarkdown: view.statementMd,
      options: (view.mcq?.options ?? []).map((o) => ({ id: o.id, label: o.text })),
      saved: view.saved,
    };
  }
  return {
    id: view.sessionQuestionId,
    type: 'coding',
    title: view.title,
    points,
    statementMarkdown: view.statementMd,
    languages: view.languages,
    starterCode: view.starterCode,
    sampleTests: view.samples.map((s, i) => ({
      id: `${view.sessionQuestionId}-s${i + 1}`,
      name: `Sample ${i + 1}`,
      input: s.input,
      expectedOutput: s.expectedOutput,
    })),
    saved: view.saved,
  };
}

/** The open section is the highest one that has started (the next opens when one is finished). */
export function openSection(layout: TestLayout): TestLayout['sections'][number] | null {
  const started = layout.sections.filter((s) => s.startedAt !== null);
  return started.length === 0 ? null : started.reduce((a, b) => (b.position > a.position ? b : a));
}

export function createAdrSource(hooks: { onSessionEnded: () => void }): TestSource {
  const ended = <T>(r: ApiResult<T>): void => {
    if (!r.ok && r.kind === 'problem' && r.status === 401) hooks.onSessionEnded();
  };

  async function load(): Promise<Schemas['CandidateSession']> {
    const layoutResult = await requestAt(testLayoutSchema, '/session/test', {
      method: 'GET',
      authed: true,
    });
    ended(layoutResult);
    if (!layoutResult.ok) throw new TestLoadError('unavailable');
    const layout = layoutResult.data;
    const section = openSection(layout);
    if (!section) throw new TestLoadError('unavailable');
    const views = await Promise.all(
      section.questions.map((q) =>
        requestAt(questionViewSchema, `/questions/${encodeURIComponent(q.sessionQuestionId)}`, {
          method: 'GET',
          authed: true,
        }),
      ),
    );
    views.forEach(ended);
    const questions: TestQuestion[] = [];
    for (const [i, v] of views.entries()) {
      const points = Number(section.questions[i]?.points ?? 0);
      if (!v.ok) {
        // A question this page cannot read (a view in a shape it does not know) degrades to a
        // notice for that question only; a network or server failure still fails the load.
        if (v.kind === 'shape') {
          questions.push({
            id: section.questions[i]?.sessionQuestionId ?? `unsupported-${i}`,
            type: 'mcq',
            format: 'unsupported',
            title: `Question ${i + 1}`,
            points,
            statementMarkdown: '',
            options: [],
          });
          continue;
        }
        throw new TestLoadError('unavailable');
      }
      questions.push(questionFor(v.data, points));
    }
    return {
      // The contract carries no test title; the screen shows a neutral one.
      testTitle: 'Your assessment',
      testDeadlineAt: layout.deadlineAt,
      section: {
        id: String(section.position),
        position: section.position,
        totalSections: layout.sections.length,
        title: section.title,
        deadlineAt: section.deadlineAt,
      },
      questions,
    };
  }

  return {
    isDemo: false,
    loadSession: load,
    async readSession(opts) {
      // A lost answer to the last section's finish: the server may have submitted the test. Ask for
      // the state first, so "over" is told apart from "could not read".
      const state = await requestAt(sessionStateSchema, '/session', {
        method: 'GET',
        authed: true,
      });
      ended(state);
      if (state.ok && isOverStatus(state.data.status)) {
        return { submitted: true };
      }
      // Any other status that is not running (an unknown value) is "could not read", not "over".
      if (state.ok && !(RUNNING_STATUSES as readonly string[]).includes(state.data.status)) {
        return null;
      }
      if (
        !state.ok &&
        state.kind === 'problem' &&
        state.status === 409 &&
        state.code === 'SESSION_NOT_ACTIVE'
      ) {
        return { submitted: true };
      }
      // The last section is closed and not yet submitted: its questions answer 409, do not ask.
      if (opts?.stateOnly) return null;
      try {
        return await load();
      } catch {
        return null;
      }
    },
    async serverNow() {
      const r = await requestAt(sessionStateSchema, '/session', { method: 'GET', authed: true });
      ended(r);
      if (!r.ok) throw new Error('Could not read the server time');
      return r.data.serverTime;
    },
    async saveDraft(questionId, body) {
      // The API's DraftDto (whitelisted: an unknown field is a 400): CODING `{ code, language }`;
      // MCQ `{ answer: { optionIds } }`. The screen's own `kind` field is never sent.
      // SHORT_ANSWER `{ answer: { text } }`.
      const dto =
        body.kind === 'code'
          ? { code: body.code, language: body.language }
          : body.kind === 'text'
            ? { answer: { text: body.text } }
            : { answer: { optionIds: [body.selectedOptionId] } };
      const r = await requestAt(
        draftSavedSchema,
        `/answers/${encodeURIComponent(questionId)}/draft`,
        { method: 'PUT', body: dto, authed: true },
      );
      ended(r);
      if (r.ok) return { ok: true, savedAt: r.data.savedAt };
      return {
        ok: false,
        paused: r.kind === 'problem' && r.status === 409 && r.code === 'SESSION_PAUSED',
      };
    },
    async run(questionId, language, code) {
      const r = await requestAt(
        runResponseSchema,
        `/answers/${encodeURIComponent(questionId)}/run`,
        {
          method: 'POST',
          body: { language, code },
          authed: true,
        },
      );
      ended(r);
      if (r.ok) return { kind: 'result', result: r.data };
      if (r.kind === 'problem' && r.status === 429)
        return { kind: 'rate-limited', retryAfterSeconds: r.retryAfterSeconds };
      if (r.kind === 'problem' && r.status === 409 && r.code === 'SESSION_PAUSED')
        return { kind: 'paused' };
      return { kind: 'error' };
    },
    async finishSection(sectionId) {
      // The position of the section on screen, the same for every retry of this attempt.
      const position = Number.parseInt(sectionId, 10);
      if (!Number.isInteger(position) || position < 1) return { kind: 'failed' };
      const r = await requestAt(sectionFinishAcceptedSchema, '/session/section/finish', {
        method: 'POST',
        body: { position },
        authed: true,
      });
      ended(r);
      // ADR 0002: finished only on a confirmed 202. 409 SECTION_NOT_OPEN is never "finished".
      if (r.ok)
        return { kind: 'finished', nextSectionId: null, submitted: false, acceptedOnly: true };
      if (r.kind === 'problem') return r.status === 409 ? { kind: 'conflict' } : { kind: 'failed' };
      return { kind: 'unreachable' };
    },
  };
}
