import { projectAccommodations } from './accommodations-projection.service';

describe('Accommodations projection (ADR 0013 CS-4.4, ADR 0015 section 3; FR-305, C-19, C-34)', () => {
  it('FR-305: an empty value is no accommodation', () => {
    expect(projectAccommodations({}, false)).toEqual({
      extraTimePct: 0,
      disabledDetectors: [],
      allowedAssistiveTools: [],
      identityCheckWaived: false,
      faceDetectorsOff: false,
    });
  });

  it('C-19: the waiver is reported as a fact and its reason, the reason code and the notes never leave the server', () => {
    const view = projectAccommodations(
      {
        extraTimePct: 25,
        disabledDetectors: ['FACE', 'GAZE', 'NOT_A_DETECTOR', 7],
        allowedAssistiveTools: ['screen reader', '', 5],
        notes: 'secret note',
        reasonCode: 'MEDICAL',
        reasonNote: 'secret reason',
        identityCheckWaiver: { reasonCode: 'REFUSED_BIOMETRIC_PROCESSING', reasonNote: 'secret' },
      },
      false,
    );
    expect(view).toEqual({
      extraTimePct: 25,
      disabledDetectors: ['FACE', 'GAZE'],
      allowedAssistiveTools: ['screen reader'],
      identityCheckWaived: true,
      faceDetectorsOff: true,
    });
    expect(JSON.stringify(view)).not.toMatch(/secret|MEDICAL|REFUSED/);
  });

  it('ADR 0015 section 7: the server-only identityCheckWaived leftover and a WAIVED row both mean waived', () => {
    expect(projectAccommodations({ identityCheckWaived: true }, false).identityCheckWaived).toBe(
      true,
    );
    expect(projectAccommodations({}, true).identityCheckWaived).toBe(true);
  });

  it('FR-305: an over-cap or malformed extra time is none', () => {
    expect(projectAccommodations({ extraTimePct: 900 }, false).extraTimePct).toBe(0);
    expect(projectAccommodations({ extraTimePct: 'x' }, false).extraTimePct).toBe(0);
  });
});
