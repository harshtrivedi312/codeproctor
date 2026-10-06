import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MIN_ASSISTANTS,
  MAX_MIN_ASSISTANTS,
  orgSettingsPatchBodySchema,
  orgSettingsPatchSchema,
  orgSettingsSchema,
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
  void it('FR-103: the schemas are strict at every level (unknown and nested unknown keys refused)', () => {
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
  void it('FR-103: the PATCH body needs currentPassword and at least one setting', () => {
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
});
