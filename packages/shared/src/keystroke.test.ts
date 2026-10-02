import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_KEYSTROKE_EVENTS_PER_BATCH,
  MAX_SOURCE_CODE_LENGTH,
  keystrokeBatchSchema,
  type KeystrokeEvent,
} from './index';

const UUID = '3f0e3c2a-6b1d-4c8e-9f2a-1b2c3d4e5f60';
const AT = '2026-10-02T10:00:00.000Z';

function batch(events: unknown[]) {
  return { seq: 0, sessionQuestionId: UUID, startedAt: AT, events };
}

/** Apply RESET and EDIT events in order, as the replay panel does (FR-901). */
function replay(events: KeystrokeEvent[]): string {
  let code = '';
  for (const e of events) {
    if (e.kind === 'RESET') code = e.text;
    else if (e.kind === 'EDIT')
      code = code.slice(0, e.offset) + e.text + code.slice(e.offset + e.deleteLength);
  }
  return code;
}

void describe('keystroke batch (FR-608)', () => {
  void it('FR-608, TC-062: insert, delete and cursor events replay to the final code', () => {
    const parsed = keystrokeBatchSchema.parse(
      batch([
        { kind: 'RESET', t: 0, language: 'python', text: 'def f():\n    pass\n' },
        { kind: 'EDIT', t: 120, offset: 13, deleteLength: 4, text: 'return 1' },
        { kind: 'CURSOR', t: 300, offset: 21 },
        { kind: 'EDIT', t: 450, offset: 20, deleteLength: 1, text: '' },
        { kind: 'EDIT', t: 500, offset: 20, deleteLength: 0, text: '42' },
      ]),
    );
    assert.equal(replay(parsed.events), 'def f():\n    return 42\n');
  });
  void it('FR-608: privacy first, raw key fields are stripped', () => {
    const parsed = keystrokeBatchSchema.parse(
      batch([
        { kind: 'EDIT', t: 0, offset: 0, deleteLength: 0, text: 'a', key: 'a', code: 'KeyA' },
      ]),
    );
    assert.deepEqual(Object.keys(parsed.events[0] ?? {}).sort(), [
      'deleteLength',
      'kind',
      'offset',
      't',
      'text',
    ]);
  });
  void it('rejects unknown kinds, no-op edits and out-of-order timestamps', () => {
    assert.equal(keystrokeBatchSchema.safeParse(batch([{ kind: 'KEYDOWN', t: 0 }])).success, false);
    assert.equal(
      keystrokeBatchSchema.safeParse(
        batch([{ kind: 'EDIT', t: 0, offset: 0, deleteLength: 0, text: '' }]),
      ).success,
      false,
    );
    assert.equal(
      keystrokeBatchSchema.safeParse(
        batch([
          { kind: 'CURSOR', t: 50, offset: 0 },
          { kind: 'CURSOR', t: 10, offset: 0 },
        ]),
      ).success,
      false,
    );
  });
  void it('NFR-04: bounds event count and total inserted text', () => {
    const cursor = { kind: 'CURSOR', t: 0, offset: 0 };
    assert.equal(
      keystrokeBatchSchema.safeParse(
        batch(Array.from({ length: MAX_KEYSTROKE_EVENTS_PER_BATCH + 1 }, () => cursor)),
      ).success,
      false,
    );
    const half = 'x'.repeat(MAX_SOURCE_CODE_LENGTH / 2 + 1);
    assert.equal(
      keystrokeBatchSchema.safeParse(
        batch([
          { kind: 'EDIT', t: 0, offset: 0, deleteLength: 0, text: half },
          { kind: 'EDIT', t: 1, offset: 0, deleteLength: 0, text: half },
        ]),
      ).success,
      false,
    );
  });
  void it('rejects a language outside CODE_LANGUAGES in RESET', () => {
    assert.equal(
      keystrokeBatchSchema.safeParse(batch([{ kind: 'RESET', t: 0, language: 'ruby', text: '' }]))
        .success,
      false,
    );
  });
});
