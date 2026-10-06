import { z } from 'zod';

/** Hard server-side caps (FR-503). A question's limits can lower these, never raise them. */
export const LIMIT_CAPS = {
  cpu_ms: 10_000,
  wall_ms: 20_000,
  memory_kb: 512 * 1024,
} as const;

/** Same defaults as question_versions.limits. */
export const DEFAULT_LIMITS = { cpu_ms: 2000, wall_ms: 5000, memory_kb: 262_144 } as const;

export const limitsSchema = z.object({
  cpu_ms: z.number().int().min(100),
  wall_ms: z.number().int().min(100),
  memory_kb: z
    .number()
    .int()
    .min(16 * 1024),
});

export interface EffectiveLimits {
  readonly cpuMs: number;
  readonly wallMs: number;
  readonly memoryKb: number;
  /** True when a question value exceeded a cap and was lowered. */
  readonly clamped: boolean;
}

export class InvalidLimitsError extends Error {
  constructor() {
    super('Question limits are invalid');
    this.name = 'InvalidLimitsError';
  }
}

/** Validates question_versions.limits and applies the caps. Wall time is never below CPU time. */
export function resolveLimits(raw: unknown): EffectiveLimits {
  const parsed = limitsSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidLimitsError();
  const cpuMs = Math.min(parsed.data.cpu_ms, LIMIT_CAPS.cpu_ms);
  const wallMs = Math.min(Math.max(parsed.data.wall_ms, cpuMs), LIMIT_CAPS.wall_ms);
  const memoryKb = Math.min(parsed.data.memory_kb, LIMIT_CAPS.memory_kb);
  const clamped =
    cpuMs !== parsed.data.cpu_ms ||
    wallMs !== parsed.data.wall_ms ||
    memoryKb !== parsed.data.memory_kb;
  return { cpuMs, wallMs, memoryKb, clamped };
}
