import { deriveOptionId, OptionIdService } from './option-ids';

const SECRET = 's'.repeat(48);
const EXPECTED_VECTOR = 'opt_7npnmgc7i5';
const service = (secret: string | undefined): OptionIdService =>
  new OptionIdService({ get: () => secret } as never);

describe('Opaque MCQ option ids (ADR 0013 CS-4.6; FR-205, TC-011)', () => {
  it('TC-011: the id is opt_ plus 10 base32 characters and never the author id', () => {
    const id = deriveOptionId(SECRET, 'session-1', 'correct');
    expect(id).toMatch(/^opt_[a-z2-7]{10}$/);
    expect(id).not.toContain('correct');
  });

  it('FR-205: the same session and option always give the same id (draft, render and grading agree)', () => {
    expect(deriveOptionId(SECRET, 's1', 'a')).toBe(deriveOptionId(SECRET, 's1', 'a'));
    expect(service(SECRET).of('s1', 'a')).toBe(deriveOptionId(SECRET, 's1', 'a'));
  });

  it('TC-011: two sessions get different ids for the same option, and a different secret changes every id', () => {
    expect(deriveOptionId(SECRET, 's1', 'a')).not.toBe(deriveOptionId(SECRET, 's2', 'a'));
    expect(deriveOptionId(SECRET, 's1', 'a')).not.toBe(deriveOptionId('t'.repeat(48), 's1', 'a'));
  });

  it('TC-011: a pinned known-answer vector (the derivation cannot drift silently)', () => {
    expect(deriveOptionId('k'.repeat(32), '00000000-0000-4000-8000-000000000001', 'a')).toBe(
      EXPECTED_VECTOR,
    );
  });

  it('FR-205: mapAll maps every option of a question to distinct ids', () => {
    const map = service(SECRET).mapAll('s1', ['a', 'b', 'c']);
    expect([...map.keys()]).toEqual(['a', 'b', 'c']);
    expect(new Set(map.values()).size).toBe(3);
  });

  it('NFR-04: without the secret the candidate portal is unconfigured (503), never a fallback id', () => {
    let code: unknown;
    try {
      service(undefined).of('s1', 'a');
    } catch (e) {
      code = (e as { getResponse?: () => { code?: string } }).getResponse?.().code;
    }
    expect(code).toBe('CANDIDATE_PORTAL_UNCONFIGURED');
  });
});
