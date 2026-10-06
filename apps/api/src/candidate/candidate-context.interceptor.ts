// Runs the handler of a guarded candidate route inside the org scope of the token's session
// (ADR 0006: candidate routes call runInOrg with the org from the verified token). The guard has
// already put the context on the request; a request without one is refused, never run unscoped.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { CandidateScope } from './candidate-scope';
import type { CandidateRequest } from './candidate.types';

@Injectable()
export class CandidateContextInterceptor implements NestInterceptor {
  constructor(private readonly scope: CandidateScope) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const candidate = context.switchToHttp().getRequest<CandidateRequest>().candidate;
    if (candidate === undefined) throw new UnauthorizedException('Authentication required.');
    return new Observable<unknown>((subscriber) => {
      const subscription = this.scope.enter(candidate, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
