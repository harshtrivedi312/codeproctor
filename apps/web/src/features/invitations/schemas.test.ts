import { describe, expect, it } from 'vitest';
import { inviteSchema, toAccommodations, type InviteFormValues } from './schemas';

const NOW = new Date('2026-06-01T09:00:00');
const base: InviteFormValues = {
  testId: 't1',
  mode: 'one',
  name: 'Ada',
  email: 'ada@example.test',
  windowStart: '2026-06-01T09:00',
  windowEnd: '2026-06-08T09:00',
  extraTime: '',
  disabledDetectors: [],
  toolsText: '',
  notes: '',
  waiver: false,
  waiverReason: '',
  waiverNote: '',
};
const schema = inviteSchema(() => NOW);
const paths = (v: Partial<InviteFormValues>) => {
  const r = schema.safeParse({ ...base, ...v });
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
};

describe('FR-303 FR-305 ADR 0015: the invite form rules', () => {
  it('accepts a plain invitation', () => expect(paths({})).toEqual([]));

  it('needs a name, a valid email and a window that closes in the future', () => {
    expect(paths({ name: ' ' })).toEqual(['name']);
    expect(paths({ email: 'nope' })).toEqual(['email']);
    expect(paths({ windowEnd: '2026-06-01T09:00' })).toEqual(['windowEnd']);
    expect(paths({ windowStart: '2026-05-01T09:00', windowEnd: '2026-05-02T09:00' })).toEqual([
      'windowEnd',
    ]);
  });

  it('needs a test unless it is fixed', () => {
    expect(paths({ testId: '' })).toEqual(['testId']);
    expect(inviteSchema(() => NOW, true).safeParse({ ...base, testId: '' }).success).toBe(true);
  });

  it('TC-023: a CSV upload does not need a name or email in the form', () => {
    expect(paths({ mode: 'many', name: '', email: '' })).toEqual([]);
  });

  it('extra time is a whole number from 0 to 200', () => {
    expect(paths({ extraTime: '50' })).toEqual([]);
    expect(paths({ extraTime: '201' })).toEqual(['extraTime']);
    expect(paths({ extraTime: '-1' })).toEqual(['extraTime']);
    expect(paths({ extraTime: '12.5' })).toEqual(['extraTime']);
  });

  it('limits assistive tools and notes', () => {
    expect(paths({ toolsText: Array.from({ length: 11 }, (_, i) => `t${i}`).join(',') })).toEqual([
      'toolsText',
    ]);
    expect(paths({ toolsText: 'x'.repeat(81) })).toEqual(['toolsText']);
    expect(paths({ notes: 'n'.repeat(1001) })).toEqual(['notes']);
  });

  it('C-19: the identity waiver needs a reason; OTHER also needs a note', () => {
    expect(paths({ waiver: true })).toEqual(['waiverReason']);
    expect(paths({ waiver: true, waiverReason: 'CANNOT_COMPLETE_ID_CHECK' })).toEqual([]);
    expect(paths({ waiver: true, waiverReason: 'OTHER' })).toEqual(['waiverNote']);
    expect(paths({ waiver: true, waiverReason: 'OTHER', waiverNote: '  ' })).toEqual([
      'waiverNote',
    ]);
    expect(paths({ waiver: true, waiverReason: 'OTHER', waiverNote: 'Court order' })).toEqual([]);
  });

  it('builds accommodations: nothing set gives null, refusing biometrics also switches off face and gaze', () => {
    expect(toAccommodations(base)).toBeNull();
    expect(toAccommodations({ ...base, mode: 'many', extraTime: '50' })).toBeNull();
    const a = toAccommodations({
      ...base,
      extraTime: '50',
      toolsText: 'screen reader, screen reader, magnifier',
      waiver: true,
      waiverReason: 'REFUSED_BIOMETRIC_PROCESSING',
    });
    expect(a).toEqual({
      extraTimePct: 50,
      disabledDetectors: ['FACE', 'GAZE'],
      allowedAssistiveTools: ['screen reader', 'magnifier'],
      identityCheckWaiver: { reasonCode: 'REFUSED_BIOMETRIC_PROCESSING' },
    });
    expect(
      toAccommodations({ ...base, waiver: true, waiverReason: 'OTHER', waiverNote: ' why ' })
        ?.identityCheckWaiver,
    ).toEqual({ reasonCode: 'OTHER', reasonNote: 'why' });
  });
});
