import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/mocks/server';
import { createFakeLocks } from '@/test/fake-web-locks';

/*
 * Cross-tab single flight for POST /v1/auth/refresh (FR-104, TC-005). A "tab" here is a fresh copy
 * of the session modules (vi.resetModules) sharing one fake Web Locks and one fake BroadcastChannel
 * bus, which is what real tabs share.
 */

type Session = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: 'RECRUITER';
    orgName: string;
    totpEnabled: boolean;
    twoFactorRecommended: boolean;
  };
};
const sessionFor = (token: string, id = 'u-1'): Session => ({
  accessToken: token,
  user: {
    id,
    email: `${id}@example.test`,
    name: 'R',
    role: 'RECRUITER',
    orgName: 'Org',
    totpEnabled: false,
    twoFactorRecommended: true,
  },
});

/* ---- fakes shared by all simulated tabs ------------------------------------------------------ */
const channels = new Set<FakeChannel>();
class FakeChannel {
  onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
  constructor(public name: string) {
    channels.add(this);
  }
  postMessage(data: unknown): void {
    // Structured clone, delivered later, never to the sender: like the real thing.
    const copy = structuredClone(data);
    for (const c of channels) {
      if (c !== this && c.name === this.name) {
        setTimeout(() => c.onmessage?.({ data: copy } as MessageEvent<unknown>), 0);
      }
    }
  }
  close(): void {
    channels.delete(this);
  }
}

interface Tab {
  auth: typeof import('@/lib/auth-session');
  token: typeof import('@/lib/auth-token');
  busy: typeof import('@/lib/api/busy');
}
async function openTab(): Promise<Tab> {
  vi.resetModules();
  const [auth, token, busy] = await Promise.all([
    import('@/lib/auth-session'),
    import('@/lib/auth-token'),
    import('@/lib/api/busy'),
  ]);
  return { auth, token, busy };
}

const origLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
const origBC = globalThis.BroadcastChannel;
function installFakes(withLocks: boolean) {
  channels.clear();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: withLocks ? createFakeLocks() : undefined,
  });
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
}

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  installFakes(true);
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  if (origLocks) Object.defineProperty(navigator, 'locks', origLocks);
  else delete (navigator as unknown as { locks?: unknown }).locks;
  globalThis.BroadcastChannel = origBC;
});

function refreshServer(answer: () => Response | Promise<Response>) {
  const calls = { n: 0 };
  server.use(
    http.post('*/v1/auth/refresh', async () => {
      calls.n += 1;
      return answer();
    }),
  );
  return calls;
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe('FR-104, TC-005: one refresh across tabs', () => {
  it('two tabs refreshing at once send exactly one request and both get its session', async () => {
    const calls = refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const a = await openTab();
    const b = await openTab();
    const [ra, rb] = await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    expect(calls.n).toBe(1);
    expect(ra?.accessToken).toBe('tok-A');
    expect(rb?.accessToken).toBe('tok-A');
    expect(a.token.getAccessToken()).toBe('tok-A');
    expect(b.token.getAccessToken()).toBe('tok-A');
    expect(b.auth.getSessionUserId()).toBe('u-1');
  });

  it('three tabs at once still send one request', async () => {
    const calls = refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const tabs = [await openTab(), await openTab(), await openTab()];
    const results = await Promise.all(tabs.map((t) => t.auth.refreshSession()));
    expect(calls.n).toBe(1);
    expect(results.every((r) => r?.accessToken === 'tok-A')).toBe(true);
  });

  it('a tab that refreshes alone, later, sends its own request (no stale outcome is reused)', async () => {
    let n = 0;
    const calls = refreshServer(() => HttpResponse.json(sessionFor(`tok-${(n += 1)}`)));
    const a = await openTab();
    const b = await openTab();
    expect((await a.auth.refreshSession())?.accessToken).toBe('tok-1');
    await flush();
    expect((await b.auth.refreshSession())?.accessToken).toBe('tok-2');
    expect(calls.n).toBe(2);
  });

  it('503 BUSY then success: the winner retries once, the other tab sends nothing and does not sign out', async () => {
    let n = 0;
    const calls = refreshServer(() =>
      (n += 1) === 1
        ? HttpResponse.json(
            { code: 'BUSY', status: 503, title: 'Busy' },
            { status: 503, headers: { 'Retry-After': '1' } },
          )
        : HttpResponse.json(sessionFor('tok-B')),
    );
    const a = await openTab();
    const b = await openTab();
    const [ra, rb] = await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    expect(calls.n).toBe(2); // the BUSY answer and the one success; never a second sender
    expect(ra?.accessToken).toBe('tok-B');
    expect(rb?.accessToken).toBe('tok-B');
  });

  it('a BUSY refresh that gives up signs nobody out, in either tab', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const calls = refreshServer(() =>
      HttpResponse.json(
        { code: 'BUSY', status: 503, title: 'Busy' },
        { status: 503, headers: { 'Retry-After': '1' } },
      ),
    );
    const a = await openTab();
    const b = await openTab();
    a.auth.publishSession(sessionFor('old-A'));
    b.auth.publishSession(sessionFor('old-B'));
    const pa = a.auth.refreshSession();
    const pb = b.auth.refreshSession();
    // Advance in steps: the waiting tab arms its own timer only after the winner finished.
    for (let i = 0; i < 40; i += 1) await vi.advanceTimersByTimeAsync(1000);
    expect(await pa).toBeNull();
    expect(await pb).toBeNull();
    expect(calls.n).toBe(4); // one tab, 4 attempts
    expect(a.token.getAccessToken()).toBe('old-A');
    expect(b.token.getAccessToken()).toBe('old-B');
    expect(a.busy.busyStore.get().refreshBusy).toBe(true);
    expect(b.busy.busyStore.get().refreshBusy).toBe(true);
  });

  it('401 with the cookie cleared signs both tabs out and nobody retries', async () => {
    const calls = refreshServer(() => new HttpResponse(null, { status: 401 }));
    const a = await openTab();
    const b = await openTab();
    a.auth.publishSession(sessionFor('old-A'));
    b.auth.publishSession(sessionFor('old-B'));
    const seen: (Session | null)[] = [];
    b.auth.onSessionChange((s) => seen.push(s as Session | null));
    const [ra, rb] = await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    expect(ra).toBeNull();
    expect(rb).toBeNull();
    expect(calls.n).toBe(1);
    expect(a.token.getAccessToken()).toBeNull();
    expect(b.token.getAccessToken()).toBeNull();
    expect(seen.at(-1)).toBeNull();
  });

  it('a tab that signs out while waiting for the lock ignores the winner outcome', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    refreshServer(async () => {
      await gate;
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const a = await openTab();
    const b = await openTab();
    const pa = a.auth.refreshSession();
    await flush();
    b.auth.publishSession(sessionFor('old-B'));
    const pb = b.auth.refreshSession();
    await flush();
    // This tab's identity changed while it waited (another user signed in here, or it signed out).
    b.auth.publishSession(null);
    release();
    expect((await pa)?.accessToken).toBe('tok-A');
    expect(await pb).toBeNull();
    expect(b.token.getAccessToken()).toBeNull();
    expect(b.auth.getSessionUserId()).toBeNull();
  });

  it('never applies the winner outcome to a tab signed in as someone else', async () => {
    refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return HttpResponse.json(sessionFor('tok-A', 'u-1'));
    });
    const a = await openTab();
    const b = await openTab();
    b.auth.publishSession(sessionFor('old-B', 'u-2'));
    const [, rb] = await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    expect(rb).toBeNull();
    expect(b.token.getAccessToken()).toBeNull();
    expect(b.auth.getSessionUserId()).toBeNull();
  });

  it('a tab that already has the sign-out marker set restores nothing from another tab', async () => {
    refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const a = await openTab();
    const b = await openTab();
    const pa = a.auth.refreshSession();
    const pb = b.auth.refreshSession();
    await flush();
    window.localStorage.setItem(b.auth.SIGN_OUT_MARKER_KEY, '1'); // another tab signed out
    await pa;
    expect(await pb).toBeNull();
    expect(b.token.getAccessToken()).toBeNull();
  });

  it('the winner closing without an outcome lets the waiting tab send its own request', async () => {
    const calls = refreshServer(() => HttpResponse.json(sessionFor('tok-own')));
    const a = await openTab();
    // A tab that holds the lock and never reports (closed or crashed), then lets go.
    let letGo: () => void = () => undefined;
    void navigator.locks.request('cp.refresh', () => new Promise<void>((r) => (letGo = r)));
    const pa = a.auth.refreshSession();
    await flush();
    letGo();
    expect((await pa)?.accessToken).toBe('tok-own');
    expect(calls.n).toBe(1);
  });

  it('without Web Locks a BroadcastChannel election still sends one request', async () => {
    installFakes(false);
    const calls = refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 40));
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const a = await openTab();
    const b = await openTab();
    const [ra, rb] = await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    expect(calls.n).toBe(1);
    expect(ra?.accessToken).toBe('tok-A');
    expect(rb?.accessToken).toBe('tok-A');
  });

  it('TC-005: a queued tab sends nothing when the holder signed out while it waited', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const calls = refreshServer(async () => {
      await gate;
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const a = await openTab();
    const b = await openTab();
    const pa = a.auth.refreshSession();
    await flush();
    const pb = b.auth.refreshSession(); // queued behind A
    await flush();
    void a.auth.beginSignOut(); // marker set, A's refresh abandoned (nothing is broadcast)
    release();
    expect(await pa).toBeNull();
    expect(await pb).toBeNull();
    expect(calls.n).toBe(1); // B did not send its own while A's logout is on its way
    expect(b.token.getAccessToken()).toBeNull();
  });

  it('TC-005: a waiter that gets the lock after a silent holder, with the sign-out marker set, sends nothing', async () => {
    const calls = refreshServer(() => HttpResponse.json(sessionFor('tok-own')));
    const b = await openTab();
    let letGo: () => void = () => undefined;
    void navigator.locks.request('cp.refresh', () => new Promise<void>((r) => (letGo = r)));
    const pb = b.auth.refreshSession();
    await flush();
    window.localStorage.setItem(b.auth.SIGN_OUT_MARKER_KEY, '1');
    letGo();
    expect(await pb).toBeNull();
    expect(calls.n).toBe(0);
  });

  it('a holder whose request times out shares the error: both tabs sign out, one request', async () => {
    const calls = refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return HttpResponse.error();
    });
    const a = await openTab();
    const b = await openTab();
    a.auth.publishSession(sessionFor('old-A'));
    b.auth.publishSession(sessionFor('old-B'));
    const [ra, rb] = await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    expect(ra).toBeNull();
    expect(rb).toBeNull();
    expect(calls.n).toBe(1);
    expect(a.token.getAccessToken()).toBeNull();
    expect(b.token.getAccessToken()).toBeNull();
  });

  it('a stale election entry does not stall a tab: the other tab ending frees it at once', async () => {
    installFakes(false);
    const calls = refreshServer(() => HttpResponse.json(sessionFor('tok-own')));
    const b = await openTab();
    const foreign = new FakeChannel('cp.refresh.channel');
    foreign.postMessage({ t: 'start', id: 'foreign-tab' });
    await flush();
    const pb = b.auth.refreshSession();
    await flush();
    foreign.postMessage({ t: 'end', id: 'foreign-tab' }); // it abandoned, no outcome
    expect((await pb)?.accessToken).toBe('tok-own');
    expect(calls.n).toBe(1);
  });

  it('election: three tabs, the winner abandons: the others re-elect, one sends, one request in all', async () => {
    installFakes(false);
    const calls = refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return HttpResponse.json(sessionFor('tok-next'));
    });
    const ids = ['id-1', 'id-2', 'id-3'];
    const tabs: Tab[] = [];
    for (const id of ids) {
      const spy = vi.spyOn(crypto, 'randomUUID').mockReturnValue(id);
      tabs.push(await openTab());
      spy.mockRestore();
    }
    const [t1, t2, t3] = tabs as [Tab, Tab, Tab];
    const p = tabs.map((t) => t.auth.refreshSession());
    await flush();
    t1.auth.invalidateRefreshes(); // the lowest id (the winner) abandons before it sends
    const results = await Promise.all(p);
    expect(results[0]).toBeNull();
    expect(results[1]?.accessToken).toBe('tok-next');
    expect(results[2]?.accessToken).toBe('tok-next');
    expect(calls.n).toBe(1);
    expect([t2, t3].every((t) => t.token.getAccessToken() === 'tok-next')).toBe(true);
  });

  it('election: a tab whose session ended while it waited sends nothing', async () => {
    installFakes(false);
    const calls = refreshServer(() => HttpResponse.json(sessionFor('tok-own')));
    const a = await openTab();
    const pa = a.auth.refreshSession();
    await flush();
    window.localStorage.setItem(a.auth.SIGN_OUT_MARKER_KEY, '1');
    expect(await pa).toBeNull();
    expect(calls.n).toBe(0);
  });

  it('no coordination available: canSend still guards the send', async () => {
    installFakes(false);
    globalThis.BroadcastChannel = undefined as unknown as typeof BroadcastChannel;
    const calls = refreshServer(() => HttpResponse.json(sessionFor('tok-own')));
    const a = await openTab();
    window.localStorage.setItem(a.auth.SIGN_OUT_MARKER_KEY, '1');
    expect(await a.auth.refreshSession()).toBeNull();
    expect(calls.n).toBe(0);
  });

  it('withRefreshLock: a bounded wait goes on without the lock after the timeout', async () => {
    const { withRefreshLock } = await import('@/lib/refresh-coordination');
    void navigator.locks.request('cp.refresh', () => new Promise<void>(() => undefined)); // held forever
    let ran = false;
    await withRefreshLock(() => {
      ran = true;
      return Promise.resolve();
    }, 40);
    expect(ran).toBe(true);
  });

  it('a logout waits for a refresh in another tab (same lock)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    refreshServer(async () => {
      await gate;
      return HttpResponse.json(sessionFor('tok-A'));
    });
    const a = await openTab();
    const { withRefreshLock } = await import('@/lib/refresh-coordination');
    const pa = a.auth.refreshSession();
    await flush();
    let ran = false;
    const logout = withRefreshLock(() => {
      ran = true;
      return Promise.resolve();
    });
    await flush();
    expect(ran).toBe(false);
    release();
    await pa;
    await logout;
    expect(ran).toBe(true);
  });

  it('an idle tab drops the broadcast outcome: it never holds another tab token', async () => {
    refreshServer(() => HttpResponse.json(sessionFor('tok-A')));
    const a = await openTab();
    const idle = await openTab();
    await a.auth.refreshSession();
    await flush();
    expect(idle.token.getAccessToken()).toBeNull();
  });

  it('nothing token-like is written to any browser storage or cookie, in any tab', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const cookieSet = vi.spyOn(document, 'cookie', 'set');
    refreshServer(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return HttpResponse.json(sessionFor('tok-SECRET-A'));
    });
    const a = await openTab();
    const b = await openTab();
    await Promise.all([a.auth.refreshSession(), b.auth.refreshSession()]);
    await a.auth.refreshSession();
    await flush();
    const dump = JSON.stringify([
      { ...window.localStorage },
      { ...window.sessionStorage },
      document.cookie,
      setItem.mock.calls,
      cookieSet.mock.calls,
    ]);
    expect(dump).not.toContain('tok-SECRET');
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect('indexedDB' in globalThis ? await indexedDbNames() : []).toEqual([]);
    setItem.mockRestore();
    cookieSet.mockRestore();
  });
});

async function indexedDbNames(): Promise<unknown[]> {
  const idb = (globalThis as unknown as { indexedDB?: { databases?: () => Promise<unknown[]> } })
    .indexedDB;
  return idb?.databases ? idb.databases() : [];
}
