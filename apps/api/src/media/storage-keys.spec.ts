import {
  assertKeyInSession,
  consentPdfObjectKey,
  evidenceKey,
  evidenceKeyFromWireName,
  evidenceSealedKey,
  identitySealedKey,
  identityUploadKey,
  liveThumbnailKey,
  mediaChunkKey,
  parseObjectKey,
  reportPdfKey,
  sessionPrefix,
} from './storage-keys';

const ORG = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';
const OTHER_SID = '33333333-3333-4333-8333-333333333333';
const OTHER_ORG = '44444444-4444-4444-8444-444444444444';
const ULID = '01HZX3K9QJ5W8E2M4N6P7R9T0V';
const scope = { orgId: ORG, sessionId: SID };

describe('Object key layout (FR-701, ADR 0013 section 5.7, TC-070)', () => {
  it('TC-070: media chunk keys pad segment to 6 and seq to 8 digits under the session prefix', () => {
    expect(mediaChunkKey(scope, 'SCREEN', 3, 42)).toBe(
      `orgs/${ORG}/sessions/${SID}/media/screen/000003/00000042.webm`,
    );
    expect(mediaChunkKey(scope, 'ROOM_SCAN', 9_999, 99_999_999)).toBe(
      `orgs/${ORG}/sessions/${SID}/media/room_scan/009999/99999999.webm`,
    );
  });

  it('TC-070: segment and seq outside the key padding are refused', () => {
    expect(() => mediaChunkKey(scope, 'SCREEN', 10_000, 0)).toThrow();
    expect(() => mediaChunkKey(scope, 'SCREEN', 0, 100_000_000)).toThrow();
    expect(() => mediaChunkKey(scope, 'SCREEN', -1, 0)).toThrow();
    expect(() => mediaChunkKey(scope, 'SCREEN', 0.5, 0)).toThrow();
  });

  it('FR-704: every object type follows the ADR 0013 section 5.7 table', () => {
    const p = `orgs/${ORG}/sessions/${SID}/`;
    expect(identityUploadKey(scope, 1, 'id', ULID)).toBe(`${p}identity/1/id-${ULID}.jpg`);
    expect(identitySealedKey(scope, 2, 'selfie', ULID)).toBe(
      `${p}identity/2/sealed/selfie-${ULID}.jpg`,
    );
    expect(evidenceKey(scope, ULID)).toBe(`${p}evidence/${ULID}.jpg`);
    expect(evidenceSealedKey(scope, ULID)).toBe(`${p}evidence/sealed/${ULID}.jpg`);
    expect(reportPdfKey(scope, ULID)).toBe(`${p}reports/${ULID}.pdf`);
    expect(liveThumbnailKey(scope, ULID)).toBe(`${p}live/${ULID}.jpg`);
    // The consent PDF sits outside the session prefix (own 3-year clock, ADR 0013 section 5.7).
    expect(consentPdfObjectKey(scope, ULID)).toBe(`orgs/${ORG}/consents/${SID}/${ULID}.pdf`);
    expect(consentPdfObjectKey(scope, ULID).startsWith(sessionPrefix(scope))).toBe(false);
  });

  it('FR-701: only UUIDs, ULIDs and fixed words may enter a key', () => {
    expect(() => sessionPrefix({ orgId: 'acme', sessionId: SID })).toThrow();
    expect(() => sessionPrefix({ orgId: ORG, sessionId: '../x' })).toThrow();
    expect(() => evidenceKey(scope, 'not-a-ulid')).toThrow();
    expect(() => evidenceKey(scope, `${ULID}/../x`)).toThrow();
  });

  it('FR-606: a wire evidence name maps to the key only when it is evidence/{ULID}.jpg', () => {
    expect(evidenceKeyFromWireName(scope, `evidence/${ULID}.jpg`)).toBe(evidenceKey(scope, ULID));
    for (const bad of [
      `evidence/sealed/${ULID}.jpg`,
      `../evidence/${ULID}.jpg`,
      `evidence/${ULID}.png`,
      `orgs/${ORG}/sessions/${OTHER_SID}/evidence/${ULID}.jpg`,
    ]) {
      expect(evidenceKeyFromWireName(scope, bad)).toBeNull();
    }
  });

  it('CS-3: a key outside the session prefix is refused (other session, other org, consents, tricks)', () => {
    const ok = mediaChunkKey(scope, 'WEBCAM', 0, 0);
    expect(() => assertKeyInSession(scope, ok)).not.toThrow();
    const other = mediaChunkKey({ orgId: ORG, sessionId: OTHER_SID }, 'WEBCAM', 0, 0);
    const foreign = mediaChunkKey({ orgId: OTHER_ORG, sessionId: SID }, 'WEBCAM', 0, 0);
    const consent = consentPdfObjectKey(scope, ULID);
    for (const key of [
      other,
      foreign,
      consent,
      `${sessionPrefix(scope)}media/screen/000000/00000000.webm/../../../../x`,
      `${sessionPrefix(scope)}unknown/thing`,
      `${sessionPrefix(scope)}media/screen/000000/00000000.exe`,
      '',
      ok.replace('orgs/', '/orgs/'),
    ]) {
      expect(() => assertKeyInSession(scope, key)).toThrow('not inside the session scope');
    }
  });

  it('CS-3: the scope error never carries the key', () => {
    const secret = `${sessionPrefix(scope)}weird`;
    try {
      assertKeyInSession({ orgId: ORG, sessionId: OTHER_SID }, secret);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SID);
    }
  });

  it('FR-704: parseObjectKey reads the org and session of any known key and flags sealed keys', () => {
    expect(parseObjectKey(mediaChunkKey(scope, 'AUDIO', 1, 1))).toEqual({
      orgId: ORG,
      sessionId: SID,
      sealed: false,
    });
    expect(parseObjectKey(evidenceSealedKey(scope, ULID))?.sealed).toBe(true);
    expect(parseObjectKey(consentPdfObjectKey(scope, ULID))).toEqual({
      orgId: ORG,
      sessionId: SID,
      sealed: false,
    });
    expect(parseObjectKey('orgs/x/sessions/y/media/screen/000000/00000000.webm')).toBeNull();
  });
});
