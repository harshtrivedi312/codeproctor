// Unit tests of the candidate accommodations projection (FR-305, FR-403, ADR 0013 CS-4.4,
// ADR 0015 section 4, ADR 0018 sections 2 and 4).
import { emptyAccommodations, projectAccommodations } from './accommodations.projection';

describe('projectAccommodations (FR-305, FR-403)', () => {
  it('FR-305: missing data gives the empty projection', () => {
    expect(projectAccommodations(undefined)).toEqual({
      identityCheckWaived: false,
      faceDetectorsOff: false,
      disabledDetectors: [],
      gate: { idPhotoUpload: false, roomScanAlternative: false, microphoneNotRequired: false },
    });
    expect(projectAccommodations({})).toEqual(emptyAccommodations());
  });

  it.each([[null], [[]], [['FACE']], ['FACE'], [42], [true], [() => 1]])(
    'FR-305: %p in place of the jsonb object never throws and gives the empty projection',
    (raw) => {
      expect(projectAccommodations(raw)).toEqual(emptyAccommodations());
    },
  );

  it('FR-305: malformed members are ignored, never thrown', () => {
    const out = projectAccommodations({
      disabledDetectors: 'FACE',
      identityCheckWaiver: ['x'],
      roomScanAlternative: 'yes',
      idPhotoUpload: 'true',
      microphoneNotRequired: 1,
    });
    expect(out).toEqual(emptyAccommodations());
    expect(
      projectAccommodations({ disabledDetectors: [1, null, {}, ['FACE'], 'GAZE'] })
        .disabledDetectors,
    ).toEqual(['GAZE']);
  });

  it('FR-403: detectors are sorted, deduplicated and filtered to known names; unknown never echoed', () => {
    const out = projectAccommodations({
      disabledDetectors: ['OBJECT', 'FACE', 'OBJECT', 'GAZE', 'NOT_A_DETECTOR', 'face'],
    });
    expect(out.disabledDetectors).toEqual(['FACE', 'GAZE', 'OBJECT']);
    expect(out.faceDetectorsOff).toBe(true);
    expect(JSON.stringify(out)).not.toContain('NOT_A_DETECTOR');
  });

  it('FR-403: microphoneNotRequired forces VOICE into the list (ADR 0018 section 2)', () => {
    const out = projectAccommodations({ microphoneNotRequired: true, disabledDetectors: ['FACE'] });
    expect(out.disabledDetectors).toEqual(['FACE', 'VOICE']);
    expect(out.gate.microphoneNotRequired).toBe(true);
    expect(projectAccommodations({ disabledDetectors: ['VOICE'] }).gate.microphoneNotRequired).toBe(
      false,
    );
  });

  it('FR-403: a waiver does not add detectors in the projection (the write path does, ADR 0015 section 3)', () => {
    const out = projectAccommodations({
      identityCheckWaiver: { reasonCode: 'REFUSED_BIOMETRIC_PROCESSING' },
    });
    expect(out.identityCheckWaived).toBe(true);
    expect(out.disabledDetectors).toEqual([]);
    expect(out.faceDetectorsOff).toBe(false);
  });

  it('FR-403: gate flags come from the stored keys; roomScanAlternative accepts the lenient object', () => {
    const out = projectAccommodations({
      idPhotoUpload: true,
      roomScanAlternative: { reasonCode: 'CANNOT_MOVE_CAMERA', reasonNote: 'SECRET' },
    });
    expect(out.gate).toEqual({
      idPhotoUpload: true,
      roomScanAlternative: true,
      microphoneNotRequired: false,
    });
    expect(JSON.stringify(out)).not.toMatch(/SECRET|CANNOT_MOVE_CAMERA/);
  });

  it('FR-403: only the four top-level keys and three gate keys are ever returned', () => {
    const out = projectAccommodations({
      identityCheckWaiver: { reasonCode: 'OTHER', reasonNote: 'SECRET' },
      reason: 'SECRET',
      notes: 'SECRET',
      assistiveInput: { label: 'SECRET' },
      allowedAssistiveTools: ['SECRET'],
      extraTimePct: 900,
    });
    expect(Object.keys(out).sort()).toEqual([
      'disabledDetectors',
      'faceDetectorsOff',
      'gate',
      'identityCheckWaived',
    ]);
    expect(Object.keys(out.gate).sort()).toEqual([
      'idPhotoUpload',
      'microphoneNotRequired',
      'roomScanAlternative',
    ]);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
});
