// The stored system check (ADR 0013 sections 3 and 5.4): `sessions.device_info.systemCheck =
// { passed, checkedAt }`, written by the system-check route (BE-10). Both the start of the test and
// the verify-session job ask the same question, so it lives here.
import { z } from 'zod';

/** The latest system check must be this fresh (ADR 0013 section 3). */
export const SYSTEM_CHECK_MAX_AGE_MS = 15 * 60_000;

const systemCheckSchema = z.object({
  passed: z.boolean(),
  checkedAt: z.iso.datetime(),
  // The findings that block (ADR 0013 section 5.4). When the route stores it, it must be empty.
  blocking: z.array(z.string()).optional(),
});

function parse(deviceInfo: unknown): z.infer<typeof systemCheckSchema> | null {
  const raw =
    typeof deviceInfo === 'object' && deviceInfo !== null
      ? (deviceInfo as Record<string, unknown>).systemCheck
      : undefined;
  const check = systemCheckSchema.safeParse(raw);
  return check.success ? check.data : null;
}

/**
 * A passed system check with no blocking finding (ADR 0013 section 3: what CONSENTED to VERIFIED
 * needs). No freshness window here: the start of the test re-checks that (isSystemCheckFresh).
 */
export function isSystemCheckPassed(deviceInfo: unknown): boolean {
  const check = parse(deviceInfo);
  return check !== null && check.passed && (check.blocking ?? []).length === 0;
}

/** The start of the test: a passed check, no blocking finding, and not older than the window. */
export function isSystemCheckFresh(deviceInfo: unknown, now: Date): boolean {
  const check = parse(deviceInfo);
  return (
    isSystemCheckPassed(deviceInfo) &&
    check !== null &&
    now.getTime() - Date.parse(check.checkedAt) <= SYSTEM_CHECK_MAX_AGE_MS
  );
}
