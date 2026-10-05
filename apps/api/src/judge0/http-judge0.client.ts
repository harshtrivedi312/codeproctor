import { Logger } from '@nestjs/common';
import { Judge0UnavailableError } from './judge0.types';
import type { Judge0Client, Judge0RawResult, Judge0Submission } from './judge0.types';

export interface HttpJudge0Options {
  readonly baseUrl: string;
  readonly authToken?: string;
  /** Per HTTP request timeout. */
  readonly requestTimeoutMs: number;
  /**
   * Slack added to the whole runBatch deadline. The deadline is
   * pollDeadlineMs + ceil(submissions / workerConcurrency) * longest wall limit, shared by every
   * chunk, so a big batch cannot wait chunks x pollDeadlineMs.
   */
  readonly pollDeadlineMs: number;
  /** Sandboxes Judge0 runs at once (COUNT in infra/judge0). Default 2. */
  readonly workerConcurrency?: number;
  /** Judge0 default MAX_SUBMISSION_BATCH_SIZE is 20. */
  readonly maxBatchSize?: number;
  readonly initialPollDelayMs?: number;
  readonly maxPollDelayMs?: number;
  readonly fetchFn?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

interface RawJudge0Json {
  token?: string;
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | number | null;
  wall_time?: string | number | null;
  memory?: number | null;
  exit_code?: number | null;
  status?: { id?: number } | null;
}

const FIELDS = 'token,status,stdout,stderr,compile_output,message,time,wall_time,memory,exit_code';
const TOKEN_RE = /^[0-9a-f-]{36}$/i;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** Judge0 CE over HTTP: batch submit, poll with backoff, base64 on the wire. */
export class HttpJudge0Client implements Judge0Client {
  private readonly logger = new Logger(HttpJudge0Client.name);
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly base: string;

  constructor(private readonly options: HttpJudge0Options) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.base = options.baseUrl.replace(/\/+$/, '');
  }

  async runBatch(submissions: readonly Judge0Submission[]): Promise<Judge0RawResult[]> {
    const size = this.options.maxBatchSize ?? 20;
    const concurrency = Math.max(1, this.options.workerConcurrency ?? 2);
    const longestWall = submissions.reduce((m, s) => Math.max(m, s.limits.wallMs), 0);
    const deadline =
      this.now() +
      this.options.pollDeadlineMs +
      Math.ceil(submissions.length / concurrency) * longestWall;
    const results: Judge0RawResult[] = [];
    for (let i = 0; i < submissions.length; i += size) {
      results.push(...(await this.runChunk(submissions.slice(i, i + size), deadline)));
    }
    return results;
  }

  private async runChunk(
    chunk: readonly Judge0Submission[],
    deadline: number,
  ): Promise<Judge0RawResult[]> {
    const created = await this.request<{ token?: string }[]>(
      'POST',
      '/submissions/batch?base64_encoded=true',
      {
        submissions: chunk.map((s) => ({
          language_id: s.languageId,
          source_code: b64(s.sourceCode),
          stdin: b64(s.stdin),
          // Judge0 takes seconds (float) and KB.
          cpu_time_limit: s.limits.cpuMs / 1000,
          wall_time_limit: s.limits.wallMs / 1000,
          memory_limit: s.limits.memoryKb,
          // Defence in depth; the worker network has no egress either (infra/judge0).
          enable_network: false,
          max_file_size: Math.max(1, Math.ceil(s.maxOutputBytes / 1024)),
        })),
      },
    );
    const tokens = created.map((c) => c.token);
    const valid = tokens.filter((t): t is string => typeof t === 'string' && TOKEN_RE.test(t));
    try {
      if (tokens.length !== chunk.length || valid.length !== tokens.length) {
        throw new Judge0UnavailableError('Code runner returned an unexpected response');
      }
      return await this.poll(chunk, valid, deadline);
    } finally {
      // Judge0 keeps source, stdin and expected output until deleted: remove them on every path.
      await this.deleteAll(valid);
    }
  }

  private async poll(
    chunk: readonly Judge0Submission[],
    tokens: readonly string[],
    deadline: number,
  ): Promise<Judge0RawResult[]> {
    let delay = this.options.initialPollDelayMs ?? 200;
    const maxDelay = this.options.maxPollDelayMs ?? 2000;
    for (;;) {
      const body = await this.request<{ submissions?: RawJudge0Json[] }>(
        'GET',
        `/submissions/batch?base64_encoded=true&fields=${FIELDS}&tokens=${tokens.join(',')}`,
      );
      const list = body.submissions ?? [];
      if (list.length !== chunk.length) {
        throw new Judge0UnavailableError('Code runner returned an unexpected response');
      }
      if (list.every((r) => (r.status?.id ?? 0) > 2)) {
        return list.map((r, index) => this.decode(r, chunk[index]?.maxOutputBytes ?? 0));
      }
      if (this.now() + delay > deadline) {
        this.logger.warn(`Judge0 batch of ${chunk.length} did not finish before the deadline`);
        throw new Judge0UnavailableError('Code runner timed out');
      }
      await this.sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), maxDelay);
    }
  }

  /** Best effort: never throws. Needs ENABLE_SUBMISSION_DELETE=true on the server. */
  private async deleteAll(tokens: readonly string[]): Promise<void> {
    const outcomes = await Promise.allSettled(
      tokens.map((t) => this.send('DELETE', `/submissions/${t}?fields=token`)),
    );
    const failed = outcomes.filter((o) => o.status === 'rejected' || !o.value.ok).length;
    if (failed > 0)
      this.logger.warn(`Judge0 could not delete ${failed} of ${tokens.length} submissions`);
  }

  private decode(raw: RawJudge0Json, cap: number): Judge0RawResult {
    const text = (v: string | null | undefined): string | null => {
      if (v === null || v === undefined) return null;
      // Judge0 wraps base64 in newlines: strip whitespace first, then keep at most cap bytes
      // (4 base64 chars carry 3 bytes).
      const clean = v.replace(/\s+/g, '');
      const limit = Math.ceil((cap * 4) / 3) + 4;
      return Buffer.from(clean.slice(0, limit), 'base64').subarray(0, cap).toString('utf8');
    };
    const ms = (v: string | number | null | undefined): number | null => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 1000) : null;
    };
    return {
      statusId: raw.status?.id ?? 13,
      stdout: text(raw.stdout),
      stderr: text(raw.stderr),
      compileOutput: text(raw.compile_output),
      // message is runner-generated, not candidate output; kept short.
      message: text(raw.message),
      timeMs: ms(raw.time),
      wallTimeMs: ms(raw.wall_time),
      memoryKb: raw.memory ?? null,
      exitCode: raw.exit_code ?? null,
    };
  }

  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.options.authToken) headers['X-Auth-Token'] = this.options.authToken;
    return this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.send(method, path, body);
    } catch {
      // The error text can echo the URL; log the class of failure only.
      this.logger.warn(`Judge0 ${method} failed: network error or timeout`);
      throw new Judge0UnavailableError();
    }
    if (!response.ok) {
      this.logger.warn(`Judge0 ${method} failed: HTTP ${response.status}`);
      throw new Judge0UnavailableError();
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Judge0UnavailableError('Code runner returned an unexpected response');
    }
  }
}

/** Used when JUDGE0_URL is not set: every run fails as unavailable. */
export class UnconfiguredJudge0Client implements Judge0Client {
  runBatch(): Promise<Judge0RawResult[]> {
    return Promise.reject(new Judge0UnavailableError('Code runner is not configured'));
  }
}
