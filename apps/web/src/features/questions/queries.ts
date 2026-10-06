'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Schemas } from '@/lib/api/client';
import { ApiFailure } from '@/features/admin/queries';

/*
 * TanStack Query hooks for the question bank. Question data (statements, hidden tests, reference
 * solutions, answer keys) lives only in this cache and in component state: never in a URL, in
 * storage or in a log. The cache is cleared when the signed-in user changes (AuthProvider).
 * 401 handling and its retry are the shared client's (a 403 never signs anyone out).
 */

export const questionKeys = {
  all: ['questions'] as const,
  list: ['questions', 'list'] as const,
  detail: (id: string) => ['questions', 'detail', id] as const,
  versions: (id: string) => ['questions', 'versions', id] as const,
  version: (id: string, v: number) => ['questions', 'version', id, v] as const,
  ai: (id: string) => ['questions', 'ai', id] as const,
};

function fail(response: Response, error: unknown): never {
  const message =
    error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  throw new ApiFailure(response.status, message, code);
}

export function useQuestions() {
  return useQuery({
    queryKey: questionKeys.list,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/questions');
      if (!data) fail(response, error);
      return data.items;
    },
  });
}

export function useQuestion(id: string) {
  return useQuery({
    queryKey: questionKeys.detail(id),
    // The editor owns its draft in form state; do not refetch over it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/questions/{questionId}', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data;
    },
  });
}

export function useQuestionVersions(id: string) {
  return useQuery({
    queryKey: questionKeys.versions(id),
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/questions/{questionId}/versions', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data.items;
    },
  });
}

export function useQuestionVersion(id: string, version: number) {
  return useQuery({
    queryKey: questionKeys.version(id, version),
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        '/v1/questions/{questionId}/versions/{version}',
        {
          params: { path: { questionId: id, version } },
        },
      );
      if (!data) fail(response, error);
      return data;
    },
  });
}

export function useCreateQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas['QuestionCreate']) => {
      const { data, error, response } = await api.POST('/v1/questions', { body });
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(questionKeys.detail(data.id), data);
      void qc.invalidateQueries({ queryKey: questionKeys.list });
    },
  });
}

export function useSaveQuestion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Schemas['QuestionContent']) => {
      const { data, error, response } = await api.PATCH('/v1/questions/{questionId}', {
        params: { path: { questionId: id } },
        body,
      });
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(questionKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: questionKeys.list });
      void qc.invalidateQueries({ queryKey: questionKeys.versions(id) });
    },
  });
}

export function useStartValidation(id: string) {
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/validate', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data.jobId;
    },
  });
}

/** One poll of a validation job. The editor loops over this until the job is done or failed. */
export async function fetchValidationJob(
  id: string,
  jobId: string,
): Promise<Schemas['ValidationJob']> {
  const { data, error, response } = await api.GET('/v1/questions/{questionId}/validation/{jobId}', {
    params: { path: { questionId: id, jobId } },
  });
  if (!data) fail(response, error);
  return data;
}

export function usePublishQuestion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/publish', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(questionKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: questionKeys.list });
      void qc.invalidateQueries({ queryKey: questionKeys.versions(id) });
    },
  });
}

export function usePrefill(id: string) {
  return useMutation({
    mutationFn: async (body: Schemas['PrefillRequest']) => {
      const { data, error, response } = await api.POST('/v1/questions/{questionId}/prefill', {
        params: { path: { questionId: id } },
        body,
      });
      if (!data) fail(response, error);
      return data.proposals;
    },
  });
}

export function useAiReferences(id: string) {
  return useQuery({
    queryKey: questionKeys.ai(id),
    queryFn: async () => {
      const { data, error, response } = await api.GET('/v1/questions/{questionId}/ai-references', {
        params: { path: { questionId: id } },
      });
      if (!data) fail(response, error);
      return data.items;
    },
  });
}

export function useAddAiReference(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { body: Schemas['AiReferenceInput']; supersedes?: string }) => {
      const result = vars.supersedes
        ? await api.POST('/v1/questions/{questionId}/ai-references/{referenceId}/supersede', {
            params: { path: { questionId: id, referenceId: vars.supersedes } },
            body: vars.body,
          })
        : await api.POST('/v1/questions/{questionId}/ai-references', {
            params: { path: { questionId: id } },
            body: vars.body,
          });
      if (!result.data) fail(result.response, result.error);
      return result.data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: questionKeys.ai(id) }),
  });
}
