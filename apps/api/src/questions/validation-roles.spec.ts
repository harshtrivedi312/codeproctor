import { USER_ROLES, hasPermission } from '@codeproctor/shared';

describe('FR-203, TC-011 validation report access', () => {
  // The validation report can carry diagnostics for hidden slots. That is only acceptable while
  // every role that can read it already reads hidden test data (question:update). FU-BE-127.
  it('FR-203: every role holding question:validate also holds question:update', () => {
    for (const role of USER_ROLES) {
      if (hasPermission(role, 'question:validate')) {
        expect([role, hasPermission(role, 'question:update')]).toEqual([role, true]);
      }
    }
  });
});
