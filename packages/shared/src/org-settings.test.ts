import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  DEFAULT_MIN_ASSISTANTS,
  isEmptyOrgSettingsPatch,
  MAX_MIN_ASSISTANTS,
  orgSettingsPatchBodySchema,
  orgSettingsPatchSchema,
  orgSettingsSchema,
  orgSettingsViewSchema,
} from './org-settings';

void describe('org settings contract (api-contract section 2, ADR 0005 AI-5)', () => {
  void it('AI-5: the default is 2 and the bound is 5', () => {
    assert.equal(DEFAULT_MIN_ASSISTANTS, 2);
    assert.equal(MAX_MIN_ASSISTANTS, 5);
  });
  void it('AI-5: minAssistants accepts 0..5 and refuses 6, -1, 2.5 and a string', () => {
    for (const v of [0, 1, 5]) {
      assert.equal(
        orgSettingsSchema.safeParse({ aiReferences: { minAssistants: v } }).success,
        true,
      );
    }
    for (const v of [6, -1, 2.5, '2', null]) {
      assert.equal(
        orgSettingsSchema.safeParse({ aiReferences: { minAssistants: v } }).success,
        false,
      );
    }
  });
  void it('FR-102: the schemas are strict at every level (unknown and nested unknown keys refused)', () => {
    assert.equal(orgSettingsPatchSchema.safeParse({ orgId: 'x' }).success, false);
    assert.equal(
      orgSettingsPatchSchema.safeParse({ aiReferences: { refreshDays: 90 } }).success,
      false,
    );
    assert.equal(orgSettingsPatchSchema.safeParse({ aiReferences: null }).success, false);
    assert.equal(
      orgSettingsSchema.safeParse({ aiReferences: { minAssistants: 2 }, other: 1 }).success,
      false,
    );
  });
  void it('FR-102: the PATCH body needs currentPassword and at least one setting', () => {
    const ok = { currentPassword: 'p', aiReferences: { minAssistants: 0 } };
    assert.equal(orgSettingsPatchBodySchema.safeParse(ok).success, true);
    assert.equal(
      orgSettingsPatchBodySchema.safeParse({ aiReferences: { minAssistants: 0 } }).success,
      false,
    );
    assert.equal(orgSettingsPatchBodySchema.safeParse({ currentPassword: 'p' }).success, false);
    assert.equal(
      orgSettingsPatchBodySchema.safeParse({ currentPassword: 'p', aiReferences: {} }).success,
      false,
    );
    assert.equal(
      orgSettingsPatchBodySchema.safeParse({ ...ok, currentPassword: '' }).success,
      false,
    );
    assert.equal(orgSettingsPatchBodySchema.safeParse({ ...ok, orgId: 'x' }).success, false);
  });

  void it('AI-5: the response view carries isDefault and rejects a missing or extra key', () => {
    const view = { aiReferences: { minAssistants: 2, isDefault: true } };
    assert.equal(orgSettingsViewSchema.safeParse(view).success, true);
    assert.equal(
      orgSettingsViewSchema.safeParse({ aiReferences: { minAssistants: 2 } }).success,
      false,
    );
    assert.equal(orgSettingsSchema.safeParse(view).success, false);
    assert.equal(orgSettingsSchema.safeParse({ aiReferences: {} }).success, false);
  });
  void it('FR-102: an empty patch reports one issue on aiReferences with the fixed message', () => {
    const r = orgSettingsPatchBodySchema.safeParse({ currentPassword: 'p', aiReferences: {} });
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.issues.length, 1);
    assert.deepEqual(r.error.issues[0]?.path, ['aiReferences']);
    assert.equal(r.error.issues[0]?.message, 'Send at least one setting.');
  });
  void it('FR-102: currentPassword is bounded at 1024 (1024 ok, 1025 refused)', () => {
    const body = (n: number) => ({
      currentPassword: 'x'.repeat(n),
      aiReferences: { minAssistants: 1 },
    });
    assert.equal(orgSettingsPatchBodySchema.safeParse(body(1024)).success, true);
    assert.equal(orgSettingsPatchBodySchema.safeParse(body(1025)).success, false);
  });
  void it('FR-102: null and nested unknown keys are refused through the body schema', () => {
    const base = { currentPassword: 'p' };
    assert.equal(
      orgSettingsPatchBodySchema.safeParse({ ...base, aiReferences: { minAssistants: null } })
        .success,
      false,
    );
    assert.equal(
      orgSettingsPatchBodySchema.safeParse({ ...base, aiReferences: { refreshDays: 9 } }).success,
      false,
    );
  });
  void it('NFR-04: no validation issue echoes the submitted password', () => {
    const planted = 'Planted-Pa55word-9f3c';
    const bodies = [
      { currentPassword: planted, aiReferences: {} },
      { currentPassword: planted, aiReferences: { minAssistants: 99 } },
      { currentPassword: planted, orgId: 'x', aiReferences: { minAssistants: 1 } },
      { currentPassword: planted + 'x'.repeat(1100), aiReferences: { minAssistants: 1 } },
    ];
    for (const b of bodies) {
      const r = orgSettingsPatchBodySchema.safeParse(b);
      assert.equal(r.success, false);
      if (r.success) continue;
      assert.equal(JSON.stringify(r.error.issues).includes(planted), false);
      assert.equal(JSON.stringify(z.treeifyError(r.error)).includes(planted), false);
      assert.equal(JSON.stringify(z.flattenError(r.error)).includes(planted), false);
    }
  });
  void it('FR-102: the emptiness check counts any set leaf and ignores undefined ones', () => {
    assert.equal(isEmptyOrgSettingsPatch({}), true);
    assert.equal(isEmptyOrgSettingsPatch({ aiReferences: {} }), true);
    assert.equal(isEmptyOrgSettingsPatch({ aiReferences: { minAssistants: undefined } }), true);
    assert.equal(isEmptyOrgSettingsPatch({ aiReferences: { minAssistants: 0 } }), false);
  });
});
