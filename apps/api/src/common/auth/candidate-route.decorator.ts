import { SetMetadata } from '@nestjs/common';
import type { CandidatePermission } from './route-permissions';

export const CANDIDATE_ROUTE = 'auth:candidate-route';

/**
 * Declares a candidate-facing route (ADR 0010 section 6 pseudo-role CANDIDATE, ADR 0013). It only
 * records the CANDIDATE permission the route needs; it enforces NOTHING. A candidate route needs
 * all three: @Public() (so the staff JwtAuthGuard lets it through), this marker, and
 * @UseGuards(CandidateSessionGuard) (BE-07), which reads this metadata and authenticates the
 * candidate. Without the guard the route is unauthenticated: until the guard exists, do not merge
 * a candidate route (the registry fails a CANDIDATE route that has no route guard).
 * Candidate routes write no audit rows (ADR 0013), so they carry no @Audited().
 */
export const CandidateRoute = (permission: CandidatePermission): MethodDecorator & ClassDecorator =>
  SetMetadata(CANDIDATE_ROUTE, permission);
