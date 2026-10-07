// Pure parts of the reviewer read API (FR-901, FR-703): mappers, cursor, the unconfigured storage.
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ROUTE_PERMISSIONS } from '../common/auth/route-permissions';
import { InMemoryRecordingStorage } from './recording-storage.testing';
import { UnconfiguredRecordingStorage } from './recording-storage.port';
import { decodeCursor, encodeCursor } from './review-cursor';
import { eventDetail, parseRecordingId, recordingId, runTests } from './review-mappers';

const ID = '3f2b8a52-0a6e-4f43-9d7e-1c4d3b1a9e11';

describe('review read API units (FR-901, FR-703)', () => {
  it('FR-901: eventDetail is a short string from scalar columns, or null', () => {
    expect(eventDetail(null, null)).toBeNull();
    expect(eventDetail(1200, 0.9312)).toBe('duration 1200 ms, confidence 0.93');
    expect(eventDetail(5, null)).toBe('duration 5 ms');
  });

  it('FR-901: runTests keeps a name and a status only, never output', () => {
    const tests = runTests([
      { testCaseId: 'tc1', passed: true, status: 'PASSED', stdout: 'SECRET', expected: 'SECRET' },
      { testId: 't2', passed: false, verdict: 'WRONG_ANSWER', message: 'SECRET' },
      { passed: false },
      'junk',
      null,
    ]);
    expect(tests).toEqual([
      { name: 'tc1', status: 'PASSED' },
      { name: 't2', status: 'WRONG_ANSWER' },
      { name: 'test 3', status: 'FAILED' },
    ]);
    expect(JSON.stringify(tests)).not.toContain('SECRET');
    expect(runTests({ not: 'an array' })).toEqual([]);
  });

  it('FR-701: a recording id is KIND-SEGMENT and malformed ids do not parse', () => {
    expect(recordingId('SCREEN', 2)).toBe('SCREEN-2');
    expect(parseRecordingId('WEBCAM-0')).toEqual({ kind: 'WEBCAM', segment: 0 });
    for (const bad of ['SCREEN', 'ROOM_SCAN-0', 'SCREEN--1', 'SCREEN-1x', 'screen-1', '']) {
      expect(parseRecordingId(bad)).toBeNull();
    }
  });

  it('FR-901: the queue cursor round-trips and rejects garbage with 400', () => {
    const c = { t: '2026-01-01T00:00:00.000Z', id: ID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ t: null, id: ID }))).toEqual({ t: null, id: ID });
    const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of [
      '!!',
      enc('x'),
      enc({ t: 5, id: ID }),
      enc({ t: null, id: 'nope' }),
      enc(null),
      enc({ t: '-271821-04-20T00:00:00.000Z', id: ID }),
      enc({ t: '+275760-09-13T00:00:00.000Z', id: ID }),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(BadRequestException);
    }
  });

  it('FR-703: the unconfigured storage answers 503', async () => {
    await expect(new UnconfiguredRecordingStorage().presignGet()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('FR-703: the in-memory double records the ttl', async () => {
    const s = new InMemoryRecordingStorage();
    await s.presignGet('k', 'video/webm', 900);
    expect(s.calls).toEqual([{ key: 'k', contentType: 'video/webm', ttlSeconds: 900 }]);
  });

  it('FR-103, FR-105: the three review routes are REVIEWER and SUPER_ADMIN only and audited', () => {
    for (const key of [
      'GET /review/queue',
      'GET /review/sessions/:id',
      'GET /review/sessions/:id/recordings/:recordingId/playback',
    ]) {
      expect(ROUTE_PERMISSIONS[key]).toMatchObject({
        roles: ['SUPER_ADMIN', 'REVIEWER'],
        audited: true,
      });
    }
  });
});
