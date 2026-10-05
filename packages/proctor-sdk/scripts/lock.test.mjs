import { describe, expect, it } from 'vitest';
import { sha256Hex, updateLock, verifyAgainstLock } from './lock.mjs';

const file = (name, text) => ({
  name,
  sha256: sha256Hex(Buffer.from(text)),
  bytes: Buffer.byteLength(text),
});
const describeFile = () => ({
  component: 'OBJECT',
  source: 'https://example.invalid/x',
  version: '1',
});

describe('model lock (FR-606 self-hosted models, SHA-256 pinning)', () => {
  it('FR-606: sha256 of known bytes', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('FR-606: a matching output verifies with no problems', () => {
    const scanned = [file('a.bin', 'one'), file('b.bin', 'two')];
    expect(verifyAgainstLock(scanned, updateLock(scanned, null, describeFile))).toEqual([]);
  });

  it('FR-606: a changed file, a size change, an unlisted file and a missing file all fail', () => {
    const lock = updateLock([file('a.bin', 'one'), file('b.bin', 'two')], null, describeFile);
    const problems = verifyAgainstLock([file('a.bin', 'ONE'), file('c.bin', 'new')], lock);
    expect(problems).toEqual([
      'a.bin: SHA-256 mismatch',
      'c.bin: not in the lock (run update after review)',
      'b.bin: in the lock but missing from the output',
    ]);
  });

  it('FR-606: update refreshes hashes but keeps hand-edited licence and status', () => {
    const first = updateLock([file('a.bin', 'one')], null, describeFile);
    first.files[0].licence = 'Apache-2.0';
    first.files[0].status = 'approved';
    const next = updateLock([file('a.bin', 'two'), file('n.bin', 'x')], first, describeFile);
    expect(next.files[0]).toMatchObject({
      name: 'a.bin',
      licence: 'Apache-2.0',
      status: 'approved',
    });
    expect(next.files[0].sha256).toBe(sha256Hex(Buffer.from('two')));
    expect(next.files[1]).toMatchObject({
      name: 'n.bin',
      licence: 'unverified',
      status: 'unverified',
    });
  });
});
