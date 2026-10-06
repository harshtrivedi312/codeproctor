import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@codeproctor/shared';

export const CANDIDATE_ROUTE = 'auth:candidate-route';

/**
 * Declares a candidate-facing route (ADR 0010 section 6 pseudo-role CANDIDATE, ADR 0013). It only
 * records the CANDIDATE permission the route needs; it enforces nothing. The route must also be
 * @Public() so the staff JwtAuthGuard lets it through, and the CandidateSessionGuard (BE-07) reads
 * this metadata to authorise the candidate session token. This is the single way to declare one.
 * Candidate routes write no audit rows (ADR 0013), so they carry no @Audited().
 */
export const CandidateRoute = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(CANDIDATE_ROUTE, permission);
