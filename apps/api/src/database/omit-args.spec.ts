import { OrgScopeViolationError } from './errors';
import { assertOmitValues } from './omit-args';

const check =
  (args: unknown, operation = 'findFirst', model = 'SessionQuestion') =>
  () =>
    assertOmitValues(model, operation, args);

describe('omit takes only true, in every scope (ADR 0013 CS-4.5 relation vectors; NFR-04, TC-008)', () => {
  it.each([
    ['false on a relation (selects the related row)', { omit: { questionVersion: false } }],
    ['false on a column', { omit: { answer: false } }],
    ['null', { omit: { questionVersion: null } }],
    ['0', { omit: { questionVersion: 0 } }],
    ['an empty string', { omit: { questionVersion: '' } }],
    ['undefined', { omit: { questionVersion: undefined } }],
    ['an object', { omit: { questionVersion: { select: { id: true } } } }],
  ])('TC-008 a top-level omit entry that is %s is refused', (_what, args) => {
    expect(check(args)).toThrow(OrgScopeViolationError);
  });

  it.each([
    ['_count: false (every relation count)', { omit: { _count: false } }],
    ['_count: null', { omit: { _count: null } }],
    ['_count: true', { omit: { _count: true } }],
  ])('TC-008 omit naming %s is refused', (_what, args) => {
    expect(check(args, 'findFirst', 'Session')).toThrow(/omit may not name _count/);
  });

  it.each([
    ['under an include', { include: { session: { omit: { _count: false } } } }],
    ['under a select', { select: { id: true, session: { omit: { hmacKeyEnc: false } } } }],
    [
      'two levels down',
      { include: { session: { include: { invitation: { omit: { accommodations: false } } } } } },
    ],
    [
      'under a _count select (args of a relation count)',
      { select: { _count: { select: { x: { omit: { y: false } } } } } },
    ],
  ])('TC-008 a nested omit entry that is not true is refused %s', (_what, args) => {
    expect(check(args)).toThrow(OrgScopeViolationError);
  });

  it.each([
    'findUnique',
    'findMany',
    'create',
    'createManyAndReturn',
    'update',
    'updateManyAndReturn',
    'upsert',
    'delete',
  ])('TC-008 every operation that returns a selection is checked: %s', (operation) => {
    expect(check({ omit: { questionVersion: false } }, operation)).toThrow(OrgScopeViolationError);
  });

  it('TC-008 B1 of the #314 review: relation args on another prototype (a field reference carrier) are refused', () => {
    // Built in code: a field reference's prototype (the marker that plain-args treats as a value), carrying an
    // include that Prisma reads through the prototype chain and an own-key walk does not see.
    const fieldRefLike = Object.create({ _toGraphQLInputType: () => undefined }) as object;
    const carrier = Object.create(
      Object.assign(Object.create(fieldRefLike) as object, {
        include: { invitation: { omit: { accommodations: false } } },
      }),
    ) as object;
    expect(check({ include: { session: carrier } })).toThrow(/must be a plain object/);
    expect(check({ select: { id: true, session: carrier } })).toThrow(/must be a plain object/);
    class Args {
      include = { invitation: true };
    }
    expect(check({ include: { session: new Args() } })).toThrow(/must be a plain object/);
  });

  it('TC-008 B1: an omit that is not a plain object is refused', () => {
    const inherited = Object.create({ answer: false }) as object;
    expect(check({ omit: inherited })).toThrow(/omit must be a plain object/);
  });

  it('TC-008 N4: omit null and an empty omit pass (Prisma.skip is not exported without the strictUndefinedChecks preview)', () => {
    expect(check({ omit: null })).not.toThrow();
    expect(check({ omit: {} })).not.toThrow();
  });

  it('TC-008 N2: a very long key is not echoed into the message', () => {
    const key = 'k'.repeat(10_000);
    let message = '';
    try {
      check({ omit: { [key]: false } })();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.length).toBeLessThan(400);
    expect(message).toContain('an omit entry');
  });

  it('TC-008 an omit that is not an object is refused', () => {
    expect(check({ omit: ['answer'] })).toThrow(/omit must be a plain object/);
    expect(check({ omit: 'answer' })).toThrow(/omit must be a plain object/);
  });

  it('TC-008 omit entries that are exactly true pass, top level and nested, and calls with no omit pass', () => {
    expect(check({ omit: { answer: true, finalCode: true } })).not.toThrow();
    expect(check({ include: { session: { omit: { hmacKeyEnc: true } } } })).not.toThrow();
    expect(check({ where: { id: 'x' } })).not.toThrow();
    expect(check(undefined)).not.toThrow();
    expect(
      check({ select: { _count: { select: { sections: true } } } }, 'findFirst', 'Session'),
    ).not.toThrow();
  });

  it('TC-008 a selection nested past the depth limit is refused, never passed', () => {
    let deep: Record<string, unknown> = { omit: { id: true } };
    for (let level = 0; level < 70; level += 1) deep = { include: { session: deep } };
    expect(check(deep)).toThrow(/nested too deep/);
  });

  it('TC-008 the message names the key and never a value the caller passed', () => {
    let message = '';
    try {
      check({ omit: { questionVersion: 'secret-value-123' } })();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('omit.questionVersion');
    expect(message).not.toContain('secret-value-123');
  });
});
