import { describe, expect, it } from 'vitest';
import { crumbsFor } from './breadcrumbs';

describe('crumbsFor', () => {
  it('FR-103: a malformed percent escape in the path does not throw', () => {
    expect(() => crumbsFor('/admin/candidates/%E0%A4%A')).not.toThrow();
    expect(crumbsFor('/admin/candidates/%E0%A4%A').at(-1)?.label).toBe('%E0%A4%A');
  });

  it('FR-103: a valid escape is decoded', () => {
    expect(crumbsFor('/admin/candidates/a%20b').at(-1)?.label).toBe('a b');
  });
});
