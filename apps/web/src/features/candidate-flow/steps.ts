export const STEP_IDS = ['welcome', 'verify', 'consent', 'check', 'identity', 'start'] as const;
export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  verify: 'Verify email',
  consent: 'Consent',
  check: 'System check',
  identity: 'Identity',
  start: 'Start',
};

/** Where a candidate resumes after the one-time code, from the session status the server returns. */
export function stepForStatus(
  status: 'OPENED' | 'CONSENTED' | 'VERIFIED' | 'IN_PROGRESS' | 'PAUSED',
): StepId {
  switch (status) {
    case 'OPENED':
      return 'consent';
    case 'CONSENTED':
      return 'check';
    case 'VERIFIED':
    case 'IN_PROGRESS':
    case 'PAUSED':
      return 'start';
  }
}

/**
 * The retention and destruction schedule (C-05) must be linked from the candidate portal. Until the
 * owner approves it and it is published, the link goes to a page that says so (see
 * app/(candidate)/retention). Set NEXT_PUBLIC_RETENTION_SCHEDULE_URL once it is published.
 */
export const RETENTION_SCHEDULE_HREF: string =
  process.env.NEXT_PUBLIC_RETENTION_SCHEDULE_URL ?? '/retention';
