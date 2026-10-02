import { z } from 'zod';

/**
 * Permission matrix skeleton (FR-103, ADR 0001 C-2, ADR 0010 §3).
 *
 * SKELETON: BE-03 refines it and adds the route-to-permission map that its guard and the
 * "every route is in the matrix" test use. The API is the only enforcer; the web app hides UI
 * from the same matrix. Deny by default: a permission not listed for a principal is refused.
 * Org scope is a separate check on every query (ADR 0006); a permission never crosses orgs.
 */

/** Staff roles; Postgres `user_role` (FR-103). */
export const USER_ROLES = ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'] as const;
export const userRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof userRoleSchema>;

/** Callers that are not staff users (ADR 0001 C-2). Not stored in `user_role`. */
export const PSEUDO_ROLES = ['CANDIDATE', 'SERVICE'] as const;
export type PseudoRole = (typeof PSEUDO_ROLES)[number];

export type Principal = UserRole | PseudoRole;
export const PRINCIPALS: readonly Principal[] = [...USER_ROLES, ...PSEUDO_ROLES];

/**
 * `resource:action` permissions. Comments name the fsd.md §4 route (or the doc) that needs each.
 * Public routes (/auth/login, /auth/2fa/verify, /auth/refresh, /auth/password/*,
 * /candidate/session/start) are not permissions; BE-03 marks them @Public().
 */
export const PERMISSIONS = [
  // M2 Question bank (fsd.md §4 /questions)
  'question:read', // GET /questions, /questions/:id
  'question:create', // POST /questions
  'question:update', // PATCH /questions/:id (new version, FR-204)
  'question:validate', // POST /questions/:id/validate
  'ai_reference:read', // ADR 0005 §4, BE-04
  'ai_reference:create', // ADR 0005 AI-1
  'ai_reference:supersede', // ADR 0005 AI-1
  // M3 Tests and invitations (fsd.md §4 /tests)
  'test:read', // GET /tests, /tests/:id
  'test:create', // POST /tests
  'test:update', // PATCH /tests/:id
  'invitation:create', // POST /tests/:id/invitations
  // M4-M6 Candidate session (fsd.md §4 /candidate/*), session-scoped by the candidate token
  'candidate_consent:read', // GET /candidate/session/consent
  'candidate_consent:sign', // POST /candidate/session/consent/sign
  'candidate_consent:decline', // POST /candidate/session/consent/decline
  'candidate_identity:upload', // POST /candidate/session/identity
  'candidate_media:presign', // POST /candidate/session/media/presign
  'candidate_events:write', // POST /candidate/session/events
  'candidate_keystrokes:write', // POST /candidate/session/keystrokes
  'candidate_answer:run', // POST /candidate/answers/:questionId/run
  'candidate_answer:submit', // POST /candidate/answers/:questionId/submit
  'candidate_session:finish', // POST /candidate/session/finish
  // M9 Review and live (fsd.md §4 /review, /live)
  'review_queue:read', // GET /review/queue
  'review_session:read', // GET /review/sessions/:id (audited, FR-105)
  'review_flag:decide', // PATCH /review/flags/:id
  'review_verdict:set', // POST /review/sessions/:id/verdict
  'live:view', // WS /live
  'live:pause', // WS /live pause and resume (FR-903)
  'live:message', // WS /live message (FR-903)
  // M1 Administration (backend.md Step 3; ADR 0007 §6 org settings)
  'user:manage', // invite staff, change role, deactivate
  'org_settings:manage', // retention, risk weights, consent version
] as const;
export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

const AUTHOR_PERMISSIONS = [
  'question:read',
  'question:create',
  'question:update',
  'question:validate',
  'ai_reference:read',
  'ai_reference:create',
  'ai_reference:supersede',
] as const satisfies readonly Permission[];

const RECRUITER_PERMISSIONS = [
  'question:read',
  'test:read',
  'test:create',
  'test:update',
  'invitation:create',
] as const satisfies readonly Permission[];

const REVIEWER_PERMISSIONS = [
  'review_queue:read',
  'review_session:read',
  'review_flag:decide',
  'review_verdict:set',
  'live:view',
  'live:pause',
  'live:message',
] as const satisfies readonly Permission[];

const CANDIDATE_PERMISSIONS = [
  'candidate_consent:read',
  'candidate_consent:sign',
  'candidate_consent:decline',
  'candidate_identity:upload',
  'candidate_media:presign',
  'candidate_events:write',
  'candidate_keystrokes:write',
  'candidate_answer:run',
  'candidate_answer:submit',
  'candidate_session:finish',
] as const satisfies readonly Permission[];

const STAFF_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => !(CANDIDATE_PERMISSIONS as readonly Permission[]).includes(p),
);

/**
 * Role to permissions. SUPER_ADMIN holds every staff permission (open question for BE-03: whether
 * it should hold review and live rights by default). SERVICE is empty until ARC-04 defines the
 * worker-to-API calls.
 */
export const ROLE_PERMISSIONS: Readonly<Record<Principal, readonly Permission[]>> = {
  SUPER_ADMIN: STAFF_PERMISSIONS,
  RECRUITER: RECRUITER_PERMISSIONS,
  AUTHOR: AUTHOR_PERMISSIONS,
  REVIEWER: REVIEWER_PERMISSIONS,
  CANDIDATE: CANDIDATE_PERMISSIONS,
  SERVICE: [],
};

/** Deny by default: true only when the matrix lists the permission for the principal. */
export function hasPermission(principal: Principal, permission: Permission): boolean {
  const granted: readonly Permission[] | undefined = ROLE_PERMISSIONS[principal];
  return granted !== undefined && granted.includes(permission);
}
