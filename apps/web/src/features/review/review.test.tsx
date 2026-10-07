import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { RequireRole } from '@/features/auth/require-role';
import { rolesWith } from '@/features/staff/permissions';
import { apiBaseUrl } from '@/lib/env';
import { MOCK_USERS } from '@/mocks/auth-handlers';
import { mockPlaybackUnavailable } from '@/mocks/review-handlers';
import { server } from '@/mocks/server';
import { renderAsStaff, resetAuthTestState } from '@/test/auth-test-utils';
import { nav } from '@/test/nav-mock';
import { findLoadedRow } from '@/test/table-utils';
import { ReviewQueuePage } from './review-queue-page';
import { ReviewSessionPage } from './review-session-page';

vi.mock('next/navigation', async () => (await import('@/test/nav-mock')).navigationMock());

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
beforeEach(() => {
  resetAuthTestState();
  nav.pathname = '/admin/review';
});

const U = MOCK_USERS.reviewer;

describe('FR-901 review queue', () => {
  it('FR-901: lists the sessions with risk, flags and pending manual answers, and a null risk shows a dash', async () => {
    const { container } = renderAsStaff(<ReviewQueuePage />, U);
    const row = await findLoadedRow(/Priya Nair/);
    expect(within(row).getByText('72')).toBeInTheDocument();
    expect(within(row).getByText('1 to score')).toBeInTheDocument();
    const lena = await screen.findByRole('row', { name: /Lena Fischer/ });
    expect(within(lena).getByText('-', { selector: '.rounded-full' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('FR-901: the status filter narrows the list and a row links to the detail', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ReviewQueuePage />, U);
    await findLoadedRow(/Aisha Khan/);
    await u.selectOptions(screen.getByLabelText('Status'), 'GRADED');
    await waitFor(() => expect(screen.queryByText('Priya Nair')).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Aisha Khan/ })).toHaveAttribute(
      'href',
      '/admin/review/rs-5',
    );
  });

  it('FR-901: a failed load explains and offers Try again', async () => {
    server.use(
      http.get(`${apiBaseUrl}/v1/review/queue`, () => HttpResponse.json({}, { status: 500 })),
    );
    renderAsStaff(<ReviewQueuePage />, U);
    expect(await screen.findByText('We could not load the review queue')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('C-28 FR-103: a recruiter does not get the review queue', async () => {
    renderAsStaff(
      <RequireRole roles={rolesWith('review_queue:read')}>
        <ReviewQueuePage />
      </RequireRole>,
      MOCK_USERS.recruiter,
    );
    await waitFor(() => expect(screen.queryByRole('table')).not.toBeInTheDocument());
    expect(screen.queryByText('Priya Nair')).not.toBeInTheDocument();
  });

  it('C-28: the API mock answers 403 to a recruiter', async () => {
    renderAsStaff(<div />, MOCK_USERS.recruiter);
    const res = await fetch(`${apiBaseUrl}/v1/review/queue`, {
      headers: { authorization: 'Bearer mock-access-RECRUITER-x' },
    });
    expect(res.status).toBe(403);
  });
});

describe('FR-902 review session', () => {
  it('FR-902: shows header, answers with run results, the event timeline and recordings', async () => {
    const { container } = renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    expect(await screen.findByRole('heading', { name: 'Priya Nair' })).toBeInTheDocument();
    expect(screen.getByText('Pending manual scoring')).toBeInTheDocument();
    expect(screen.getByText(/Last run: 4 of 4 tests passed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Submitted code for Merge intervals')).toHaveTextContent(
      'def merge',
    );
    const events = screen.getByRole('list', { name: 'Proctoring events' });
    expect(within(events).getAllByRole('listitem')).toHaveLength(6);
    expect(within(events).getByText('Paste blocked')).toBeInTheDocument();
    expect(within(events).getByText('Multiple faces')).toBeInTheDocument();
    expect(screen.getByText('Screen recording')).toBeInTheDocument();
    expect(screen.getByText('Audio recording')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('FR-902: the timeline filters by severity and type, ', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    await u.selectOptions(screen.getByLabelText('Severity'), 'HIGH');
    expect(
      within(screen.getByRole('list', { name: 'Proctoring events' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    await u.selectOptions(screen.getByLabelText('Severity'), 'LOW');
    const list = screen.getByRole('list', { name: 'Proctoring events' });
    expect(within(list).getByText('Reconnected')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Type'), 'TAB_SWITCH');
    expect(screen.getByText(/No events match these filters/)).toBeInTheDocument();
  });

  it('FR-902 D-23 TC-099: the verdict is blocked while a short answer is pending; scoring it unblocks the verdict', async () => {
    const u = userEvent.setup();
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    expect(screen.getByRole('button', { name: 'Set verdict' })).toBeDisabled();
    expect(screen.getByText(/1 short answer is still waiting/)).toBeInTheDocument();
    await u.type(
      screen.getByLabelText('Note (optional)', { selector: 'textarea#note-sq-3' }),
      'Good',
    );
    await u.click(screen.getByRole('button', { name: /^Correct/ }));
    expect(await screen.findByText('Decision saved.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Scored by a reviewer')).toBeInTheDocument());
    expect(screen.queryByText('Pending manual scoring')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set verdict' })).toBeEnabled();
    await u.click(screen.getByRole('button', { name: 'Set verdict' }));
    expect(await screen.findByText(/Verdict:/)).toHaveTextContent('Clean');
  });

  it('FR-902 D-23: a 409 ANSWER_NOT_MANUAL is explained with a next step', async () => {
    const u = userEvent.setup();
    server.use(
      http.patch(`${apiBaseUrl}/v1/review/sessions/:s/answers/:q`, () =>
        HttpResponse.json(
          { status: 409, title: 'Conflict', detail: 'x', code: 'ANSWER_NOT_MANUAL' },
          { status: 409 },
        ),
      ),
    );
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    await u.click(screen.getByRole('button', { name: /^Incorrect/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/scored automatically/);
  });

  it('FR-701: Play fetches the signed url on click and sets it on the media element', async () => {
    const u = userEvent.setup();
    let calls = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.url.endsWith('/playback')) calls += 1;
    });
    const { container } = renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    expect(calls).toBe(0);
    await u.click(screen.getByRole('button', { name: /Play Audio recording/ }));
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    expect(container.querySelector('audio')?.getAttribute('src')).toMatch(/^data:audio\/wav/);
    expect(calls).toBe(1);
    server.events.removeAllListeners();
  });

  it('FR-701: ordered parts play in sequence, advancing on ended', async () => {
    const u = userEvent.setup();
    server.use(
      http.get(`${apiBaseUrl}/v1/review/sessions/:s/recordings/:r/playback`, () =>
        HttpResponse.json({
          parts: [
            { url: 'blob:part-1', durationMs: 1000 },
            { url: 'blob:part-2', durationMs: 1000 },
          ],
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          contentType: 'video/webm',
        }),
      ),
    );
    const { container } = renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    await u.click(screen.getByRole('button', { name: /Play Screen recording/ }));
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const video = container.querySelector('video') as HTMLVideoElement;
    expect(video.getAttribute('src')).toBe('blob:part-1');
    video.dispatchEvent(new Event('ended'));
    await waitFor(() => expect(video.getAttribute('src')).toBe('blob:part-2'));
  });

  it('FR-701: a 503 from playback is a calm "not available yet" with no retry loop', async () => {
    const u = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(`${apiBaseUrl}/v1/review/sessions/:s/recordings/:r/playback`, () => {
        calls += 1;
        return HttpResponse.json({ status: 503, title: 'Service Unavailable' }, { status: 503 });
      }),
    );
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    await u.click(screen.getByRole('button', { name: /Play Audio recording/ }));
    expect(await screen.findByText(/Playback is not available yet/)).toBeInTheDocument();
    expect(calls).toBe(1);
  });

  it('FR-902 D-23: a 409 on scoring reloads the session so the screen shows the truth', async () => {
    const u = userEvent.setup();
    let gets = 0;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && request.url.endsWith('/v1/review/sessions/rs-1')) gets += 1;
    });
    server.use(
      http.patch(`${apiBaseUrl}/v1/review/sessions/:s/answers/:q`, () =>
        HttpResponse.json(
          { status: 409, title: 'Conflict', detail: 'x', code: 'VERDICT_ALREADY_SET' },
          { status: 409 },
        ),
      ),
    );
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    expect(gets).toBe(1);
    await u.click(screen.getByRole('button', { name: /^Correct/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/verdict is already set/);
    await waitFor(() => expect(gets).toBe(2));
    server.events.removeAllListeners();
  });

  it('FR-902: a verdict 409 with an unknown code gets a generic message, not the pending one', async () => {
    const u = userEvent.setup();
    server.use(
      http.get(`${apiBaseUrl}/v1/review/sessions/rs-2`, () => HttpResponse.json(bundleNoPending())),
      http.post(`${apiBaseUrl}/v1/review/sessions/:s/verdict`, () =>
        HttpResponse.json(
          { status: 409, title: 'Conflict', detail: 'x', code: 'SOMETHING_ELSE' },
          { status: 409 },
        ),
      ),
    );
    renderAsStaff(<ReviewSessionPage sessionId="rs-2" />, U);
    await screen.findByRole('heading', { name: 'Marco Silva' });
    await u.click(screen.getByRole('button', { name: 'Set verdict' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/session changed/);
    expect(alert).not.toHaveTextContent(/short answers still need scoring/);
  });

  it('FR-902 C-28: scoring controls and the verdict form are hidden unless the session is under review with no verdict', async () => {
    renderAsStaff(<ReviewSessionPage sessionId="rs-5" />, U);
    await screen.findByRole('heading', { name: 'Aisha Khan' });
    expect(screen.queryByRole('button', { name: 'Set verdict' })).not.toBeInTheDocument();
    expect(screen.getByText(/only while the session is under review/)).toBeInTheDocument();
  });

  it('FR-701: an expired link is refreshed once per Play click, never in a loop', async () => {
    const u = userEvent.setup();
    let calls = 0;
    server.use(
      http.get(`${apiBaseUrl}/v1/review/sessions/:s/recordings/:r/playback`, () => {
        calls += 1;
        return HttpResponse.json({
          url: 'blob:gone',
          parts: [{ url: 'blob:gone', seq: 0, durationMs: 1000 }],
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          contentType: 'audio/webm',
        });
      }),
    );
    const { container } = renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    await u.click(screen.getByRole('button', { name: /Play Audio recording/ }));
    const audio = await waitFor(() => {
      const el = container.querySelector('audio');
      expect(el).not.toBeNull();
      return el as HTMLAudioElement;
    });
    audio.dispatchEvent(new Event('error'));
    await waitFor(() => expect(calls).toBe(2));
    container.querySelector('audio')?.dispatchEvent(new Event('error'));
    expect(await screen.findByText(/We could not load this recording/)).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('FR-703: the mock playback 503 shows the calm message', async () => {
    const u = userEvent.setup();
    mockPlaybackUnavailable(true);
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, U);
    await screen.findByRole('heading', { name: 'Priya Nair' });
    await u.click(screen.getByRole('button', { name: /Play Screen recording/ }));
    expect(await screen.findByText(/Playback is not available yet/)).toBeInTheDocument();
  });

  it('C-28: a recruiter does not get the session page', async () => {
    renderAsStaff(<ReviewSessionPage sessionId="rs-1" />, MOCK_USERS.recruiter);
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Priya Nair' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText('Answers')).not.toBeInTheDocument();
  });

  it('FR-902 TC-077: run tests render PASSED, TIME_LIMIT and LOCAL_STUB with their own labels', async () => {
    server.use(
      http.get(`${apiBaseUrl}/v1/review/sessions/rs-2`, () => HttpResponse.json(bundleWithRun())),
    );
    renderAsStaff(<ReviewSessionPage sessionId="rs-2" />, U);
    await screen.findByRole('heading', { name: 'Marco Silva' });
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Time limit')).toBeInTheDocument();
    expect(screen.getByText('local stub, not real execution')).toBeInTheDocument();
    expect(screen.queryByText('Failed')).not.toBeInTheDocument();
  });

  it('FR-902: an unknown session id is a calm not-found with a way back', async () => {
    renderAsStaff(<ReviewSessionPage sessionId="nope" />, U);
    expect(await screen.findByText('This session does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the review queue' })).toBeInTheDocument();
  });
});

function bundleNoPending() {
  return {
    session: {
      id: 'rs-2',
      status: 'UNDER_REVIEW',
      startedAt: null,
      submittedAt: null,
      totalScore: 70,
      riskScore: 41,
    },
    candidate: { name: 'Marco Silva', email: 'marco.silva@example.test' },
    test: { title: 'Backend engineer screening' },
    answers: [],
    events: [],
    recordings: [],
    verdict: null,
  };
}

function bundleWithRun() {
  const b = bundleNoPending();
  return {
    ...b,
    answers: [
      {
        sessionQuestionId: 'sq-9',
        type: 'CODING',
        title: 'Run demo',
        statement: 's',
        points: 10,
        score: 5,
        scoring: 'AUTO',
        scoringNote: null,
        answer: { language: 'python', code: 'print(1)' },
        runResults: [
          {
            at: '2026-10-05T09:10:00.000Z',
            passed: 1,
            total: 3,
            tests: [
              { name: 't1', status: 'PASSED' },
              { name: 't2', status: 'TIME_LIMIT' },
              { name: 't3', status: 'LOCAL_STUB' },
            ],
          },
        ],
      },
    ],
  };
}
