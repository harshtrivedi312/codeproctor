import { afterEach, describe, expect, it } from 'vitest';
import { getAccessToken, setAccessToken } from './auth-token';

describe('access token storage (frontend rule: memory only)', () => {
  afterEach(() => setAccessToken(null));
  it('keeps the token in memory and never in web storage', () => {
    setAccessToken('secret-token');
    expect(getAccessToken()).toBe('secret-token');
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
