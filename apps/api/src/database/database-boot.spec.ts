// #126 nit 2. The one setter of the candidate facts is claimed, once per process, by candidate-facts.ts
// when it loads (org-context.ts: a second claim throws). If that file were loaded only when
// CandidateSessionGuard's file is, any module that imported org-context.ts and claimed the setter first
// would hold it. database.module.ts imports candidate-facts.ts for its side effect, so loading the
// module, which every app does, claims the setter at boot. This spec imports the module and nothing
// else that could claim it (not candidate-facts.ts, not the barrel), so a removed import fails here.
// NFR-04, TC-008.
import { DatabaseModule } from './database.module';
import { OrgScopeViolationError } from './errors';
import { claimCandidateFactsSetter } from './org-context';

describe('the candidate-facts setter is claimed at boot (ADR 0013 CS-4.4; NFR-04, TC-008)', () => {
  it('TC-008 importing DatabaseModule is enough: a later claim throws', () => {
    expect(DatabaseModule).toBeDefined();
    expect(() => claimCandidateFactsSetter()).toThrow(OrgScopeViolationError);
    expect(() => claimCandidateFactsSetter()).toThrow(/already claimed/);
  });
});
