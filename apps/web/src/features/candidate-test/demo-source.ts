import { api } from '@/lib/api/client';
import type { FinishOutcome, RunOutcome, TestSource } from './source';

/** The placeholder routes in apps/web/openapi/openapi.yaml, served by the demo mocks. */
export const demoSource: TestSource = {
  isDemo: process.env.NEXT_PUBLIC_API_MOCKING === 'enabled',

  async loadSession() {
    const { data } = await api.GET('/v1/candidate/session');
    if (!data) throw new Error('session');
    return data;
  },

  async readSession() {
    try {
      const { data } = await api.GET('/v1/candidate/session');
      return data ?? null;
    } catch {
      return null;
    }
  },

  async serverNow() {
    const { data, error } = await api.GET('/v1/time');
    if (error || !data) throw new Error('Could not read the server time');
    return data.serverNow;
  },

  async saveDraft(questionId, body) {
    try {
      const { data, response } = await api.PUT('/v1/candidate/questions/{questionId}/draft', {
        params: { path: { questionId } },
        body,
      });
      return response.ok && data
        ? { ok: true, savedAt: data.savedAt }
        : { ok: false, paused: false };
    } catch {
      return { ok: false, paused: false };
    }
  },

  async run(questionId, language, code): Promise<RunOutcome> {
    try {
      const { data, response } = await api.POST('/v1/candidate/questions/{questionId}/run', {
        params: { path: { questionId } },
        body: { language, code },
      });
      if (response.ok && data) return { kind: 'result', result: data };
      if (response.status === 429) return { kind: 'rate-limited', retryAfterSeconds: null };
      return { kind: 'error' };
    } catch {
      return { kind: 'error' };
    }
  },

  async finishSection(sectionId): Promise<FinishOutcome> {
    try {
      const { data, response } = await api.POST('/v1/candidate/sections/{sectionId}/finish', {
        params: { path: { sectionId } },
      });
      if (response.ok && data)
        return { kind: 'finished', nextSectionId: data.nextSectionId ?? null, submitted: false };
      return response.status === 409 ? { kind: 'conflict' } : { kind: 'failed' };
    } catch {
      return { kind: 'unreachable' };
    }
  },
};
