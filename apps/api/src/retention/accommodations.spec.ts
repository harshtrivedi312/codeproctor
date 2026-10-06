// Accommodation reductions (FR-704, NFR-05; ADR 0015 section 7, OQ-12, C-19).
import { reduceAccommodations, redactReasonNote } from './accommodations';

describe('redactReasonNote (R-4, ADR 0015 section 7)', () => {
  it('NFR-05: drops the note and sets reasonNoteRemoved, keeping the reason code and the settings', () => {
    const before = {
      extraTimePct: 25,
      notes: 'free text stays until erasure or R-10',
      identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'health details' },
    };
    expect(redactReasonNote(before)).toEqual({
      extraTimePct: 25,
      notes: 'free text stays until erasure or R-10',
      identityCheckWaiver: { reasonCode: 'OTHER', reasonNoteRemoved: true },
    });
  });

  it('returns null (no write) when there is no note, no waiver, or the value is not an object', () => {
    expect(redactReasonNote({ identityCheckWaiver: { reasonCode: 'CAMERA' } })).toBeNull();
    expect(
      redactReasonNote({ identityCheckWaiver: { reasonCode: 'OTHER', reasonNoteRemoved: true } }),
    ).toBeNull();
    expect(redactReasonNote({ extraTimePct: 10 })).toBeNull();
    expect(redactReasonNote(null)).toBeNull();
    expect(redactReasonNote([1])).toBeNull();
  });

  it('does not modify its input', () => {
    const before = { identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'x' } };
    redactReasonNote(before);
    expect(before.identityCheckWaiver).toEqual({ reasonCode: 'OTHER', reasonNote: 'x' });
  });
});

describe('reduceAccommodations (erasure and R-10, OQ-12)', () => {
  it('FR-704: keeps which settings were used, removes notes and the whole waiver, and keeps the fact of it', () => {
    expect(
      reduceAccommodations({
        extraTimePct: 25,
        disabledDetectors: ['GAZE'],
        allowedAssistiveTools: ['screen-reader'],
        notes: 'health information',
        identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'health details' },
      }),
    ).toEqual({
      extraTimePct: 25,
      disabledDetectors: ['GAZE'],
      allowedAssistiveTools: ['screen-reader'],
      identityCheckWaived: true,
    });
  });

  it('removes notes alone, and an unknown key (nothing outside the kept settings survives)', () => {
    expect(reduceAccommodations({ extraTimePct: 10, notes: 'x', somethingNew: 'y' })).toEqual({
      extraTimePct: 10,
    });
  });

  it('never drops identityCheckWaived', () => {
    expect(reduceAccommodations({ identityCheckWaived: true, notes: 'x' })).toEqual({
      identityCheckWaived: true,
    });
  });

  it('is idempotent: an already reduced value gives null (no write)', () => {
    const once = reduceAccommodations({ extraTimePct: 10, notes: 'x' });
    expect(once).not.toBeNull();
    expect(reduceAccommodations(once)).toBeNull();
    expect(reduceAccommodations({})).toBeNull();
    expect(reduceAccommodations({ extraTimePct: 10 })).toBeNull();
    expect(reduceAccommodations('nope')).toBeNull();
  });
});
