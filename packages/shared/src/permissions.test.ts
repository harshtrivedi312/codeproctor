import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AI_REFERENCE_LANGUAGES,
  CODE_LANGUAGES,
  PERMISSIONS,
  PRINCIPALS,
  ROLE_PERMISSIONS,
  codeLanguageSchema,
  hasPermission,
  type Permission,
} from './index';

void describe('permission matrix skeleton (FR-103)', () => {
  void it('FR-103, TC-004: a recruiter cannot edit questions or set verdicts', () => {
    assert.equal(hasPermission('RECRUITER', 'question:update'), false);
    assert.equal(hasPermission('RECRUITER', 'review_verdict:set'), false);
    assert.equal(hasPermission('RECRUITER', 'invitation:create'), true);
  });
  void it('FR-103: each role holds its own fsd.md §4 actions', () => {
    assert.equal(hasPermission('AUTHOR', 'question:validate'), true);
    assert.equal(hasPermission('REVIEWER', 'review_flag:decide'), true);
    assert.equal(hasPermission('REVIEWER', 'live:pause'), true);
    assert.equal(hasPermission('SUPER_ADMIN', 'user:manage'), true);
  });
  void it('FR-103: staff never hold candidate permissions and candidates hold no staff ones', () => {
    const candidate = new Set<Permission>(ROLE_PERMISSIONS.CANDIDATE);
    for (const role of ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'] as const) {
      for (const p of ROLE_PERMISSIONS[role]) assert.equal(candidate.has(p), false, `${role} ${p}`);
    }
    // Staff lists are built by subtracting CANDIDATE_PERMISSIONS: a candidate_* permission missing
    // from that list would leak to SUPER_ADMIN, so check the prefix as well.
    for (const role of ['SUPER_ADMIN', 'RECRUITER', 'AUTHOR', 'REVIEWER'] as const) {
      for (const p of ROLE_PERMISSIONS[role])
        assert.equal(p.startsWith('candidate_'), false, `${role} ${p}`);
    }
    assert.equal(hasPermission('SUPER_ADMIN', 'candidate_session:key'), false);
    assert.equal(hasPermission('CANDIDATE', 'candidate_session:heartbeat'), true);
    assert.equal(hasPermission('CANDIDATE', 'review_session:read'), false);
    assert.equal(hasPermission('CANDIDATE', 'candidate_events:write'), true);
  });
  void it('FR-103: deny by default, SERVICE holds nothing yet', () => {
    for (const p of PERMISSIONS) assert.equal(hasPermission('SERVICE', p), false);
  });
  void it('every permission is granted to at least one principal', () => {
    const granted = new Set(PRINCIPALS.flatMap((r) => ROLE_PERMISSIONS[r]));
    assert.deepEqual([...granted].sort(), [...PERMISSIONS].sort());
  });
});

void describe('code languages (FR-501, ADR 0005 §6)', () => {
  void it('FR-501: one list drives the schema and the AI reference languages', () => {
    assert.deepEqual(codeLanguageSchema.options, [...CODE_LANGUAGES]);
    assert.deepEqual([...AI_REFERENCE_LANGUAGES], ['python', 'javascript', 'java']);
  });
});
