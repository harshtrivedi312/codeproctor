// Object key layout for every object type (ADR 0013 section 5.7). Each environment has its own
// bucket, so keys carry no environment. Keys hold only UUIDs, ULIDs and fixed words: no names,
// emails or tokens. Keys are always built here from ids the server already holds (the token's
// session and org, rule CS-3), never from client input.
import type { MediaStream } from '../generated/prisma/enums.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const UUID_RE = new RegExp(`^${UUID}$`);
const ULID_RE = new RegExp(`^${ULID}$`);

/** The session a candidate-scope key must stay inside (rule CS-3). */
export interface SessionScope {
  readonly orgId: string;
  readonly sessionId: string;
}

export const MEDIA_STREAM_DIR: Readonly<Record<MediaStream, string>> = {
  SCREEN: 'screen',
  WEBCAM: 'webcam',
  AUDIO: 'audio',
  SIDE_CAMERA: 'side_camera',
  ROOM_SCAN: 'room_scan',
};

export type IdentityImageKind = 'id' | 'selfie';

function uuid(value: string, what: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${what} for an object key`);
  return value;
}

function ulid(value: string): string {
  if (!ULID_RE.test(value)) throw new Error('Invalid ULID for an object key');
  return value;
}

function bounded(value: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${what} for an object key`);
  }
  return value;
}

/** `orgs/{orgId}/sessions/{sessionId}/` (ends with a slash): the unit of erasure and retention. */
export function sessionPrefix(scope: SessionScope): string {
  return `orgs/${uuid(scope.orgId, 'org id')}/sessions/${uuid(scope.sessionId, 'session id')}/`;
}

/** `orgs/{orgId}/consents/{sessionId}/`: outside the session prefix (own 3-year clock, C-17). */
export function consentPrefix(scope: SessionScope): string {
  return `orgs/${uuid(scope.orgId, 'org id')}/consents/${uuid(scope.sessionId, 'session id')}/`;
}

/** Chunk key: `.../media/{stream}/{segment:06d}/{seq:08d}.webm`. Segment 0..9,999, seq 0..99,999,999. */
export function mediaChunkKey(
  scope: SessionScope,
  stream: MediaStream,
  segment: number,
  seq: number,
): string {
  const seg = String(bounded(segment, 0, 9_999, 'segment')).padStart(6, '0');
  const sq = String(bounded(seq, 0, 99_999_999, 'seq')).padStart(8, '0');
  return `${sessionPrefix(scope)}media/${MEDIA_STREAM_DIR[stream]}/${seg}/${sq}.webm`;
}

/** Initial ID image or selfie upload (deleted once sealed, BE-08). */
export function identityUploadKey(
  scope: SessionScope,
  attempt: number,
  kind: IdentityImageKind,
  id: string,
): string {
  return `${sessionPrefix(scope)}identity/${String(bounded(attempt, 1, 99, 'attempt'))}/${kind}-${ulid(id)}.jpg`;
}

/** Sealed ID image or selfie: written by the API (CopyObject), never presigned for PUT. */
export function identitySealedKey(
  scope: SessionScope,
  attempt: number,
  kind: IdentityImageKind,
  id: string,
): string {
  return `${sessionPrefix(scope)}identity/${String(bounded(attempt, 1, 99, 'attempt'))}/sealed/${kind}-${ulid(id)}.jpg`;
}

/** Evidence snapshot or re-check frame, browser PUT. The wire name is `evidence/{ULID}.jpg`. */
export function evidenceKey(scope: SessionScope, id: string): string {
  return `${sessionPrefix(scope)}evidence/${ulid(id)}.jpg`;
}

/** The server-side key for a wire evidence name; null when the name is not `evidence/{ULID}.jpg`. */
export function evidenceKeyFromWireName(scope: SessionScope, name: string): string | null {
  const m = /^evidence\/([0-9A-HJKMNP-TV-Z]{26})\.jpg$/.exec(name);
  return m?.[1] === undefined ? null : evidenceKey(scope, m[1]);
}

/** Sealed re-check frame: written by the API, never presigned for PUT. */
export function evidenceSealedKey(scope: SessionScope, id: string): string {
  return `${sessionPrefix(scope)}evidence/sealed/${ulid(id)}.jpg`;
}

export function reportPdfKey(scope: SessionScope, id: string): string {
  return `${sessionPrefix(scope)}reports/${ulid(id)}.pdf`;
}

/** Signed consent PDF, outside the session prefix. Same shape as the candidate module's key. */
export function consentPdfObjectKey(scope: SessionScope, id: string): string {
  return `${consentPrefix(scope)}${ulid(id)}.pdf`;
}

export function liveThumbnailKey(scope: SessionScope, id: string): string {
  return `${sessionPrefix(scope)}live/${ulid(id)}.jpg`;
}

const SESSION_KEY_RE = new RegExp(
  `^orgs/(${UUID})/sessions/(${UUID})/(` +
    [
      'media/(?:screen|webcam|audio|side_camera|room_scan)/\\d{6}/\\d{8}\\.webm',
      'identity/\\d{1,2}/(?:sealed/)?(?:id|selfie)-' + ULID + '\\.jpg',
      'evidence/(?:sealed/)?' + ULID + '\\.jpg',
      'reports/' + ULID + '\\.pdf',
      'live/' + ULID + '\\.jpg',
    ].join('|') +
    ')$',
);
const CONSENT_KEY_RE = new RegExp(`^orgs/(${UUID})/consents/(${UUID})/${ULID}\\.pdf$`);

export interface ParsedKey {
  readonly orgId: string;
  readonly sessionId: string;
  readonly sealed: boolean;
}

/** Parses a key of any known object type, or returns null. Anything else is refused. */
export function parseObjectKey(key: string): ParsedKey | null {
  const s = SESSION_KEY_RE.exec(key);
  if (s?.[1] !== undefined && s[2] !== undefined) {
    return { orgId: s[1], sessionId: s[2], sealed: key.includes('/sealed/') };
  }
  const c = CONSENT_KEY_RE.exec(key);
  if (c?.[1] !== undefined && c[2] !== undefined) {
    return { orgId: c[1], sessionId: c[2], sealed: false };
  }
  return null;
}

/**
 * Throws unless `key` is a well-formed key of a known layout inside `scope`'s session prefix (CS-3).
 * A candidate-scope presign passes through here, so a key outside the session (another session,
 * another org, the consent prefix, a path trick) is never signed.
 */
export function assertKeyInSession(scope: SessionScope, key: string): void {
  const parsed = parseObjectKey(key);
  const inSession = key.startsWith(sessionPrefix(scope));
  if (
    parsed === null ||
    !inSession ||
    parsed.orgId !== scope.orgId ||
    parsed.sessionId !== scope.sessionId
  ) {
    throw new ObjectKeyScopeError();
  }
}

/** Never carries the key: object keys are not logged (ADR 0013 section 5.1). */
export class ObjectKeyScopeError extends Error {
  constructor() {
    super('Object key is not inside the session scope');
    this.name = 'ObjectKeyScopeError';
  }
}

/** True for any key under a `sealed/` directory: no PUT URL is ever issued for it. */
export function isSealedKey(key: string): boolean {
  return key.includes('/sealed/');
}
