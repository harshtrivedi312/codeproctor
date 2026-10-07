import { describe, expect, it } from 'vitest';
import { VERDICT_LABEL } from './validation-panel';

describe('DL-58 local execution stub verdict', () => {
  it('DL-58: LOCAL_STUB has a plain label so a stub run is never read as real execution', () => {
    expect(VERDICT_LABEL.LOCAL_STUB).toBe('local stub, not real execution');
  });
});
