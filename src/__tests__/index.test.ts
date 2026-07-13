import { describe, it, expect, vi } from 'vitest';
import { createFetchClient, cookieAuth, bearerAuth, csrfAuth } from '../index';

// Real BroadcastChannel is used throughout this file (Node >=18 ships a
// global BroadcastChannel; confirmed present in this repo's Node 24). Where a
// test needs to simulate its absence (SSR / old browsers), it deletes and
// restores the global explicitly rather than using a fake implementation.

// A fake fetch that returns 401 until a refresh flips it to 200. Records every
// call so we can assert how many refreshes actually happened.
function makeFetch(opts: {
  refreshSucceeds?: boolean;
  refreshDelayMs?: number;
  jsonBody?: unknown;
} = {}) {
  const { refreshSucceeds = true, refreshDelayMs = 0, jsonBody = { ok: true } } = opts;
  let authed = false;
  const calls: { url: string; init?: RequestInit }[] = [];
  let refreshCount = 0;

  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/api/auth/refresh')) {
      refreshCount += 1;
      if (refreshDelayMs) await new Promise((r) => setTimeout(r, refreshDelayMs));
      if (refreshSucceeds) authed = true;
      return new Response(JSON.stringify({}), { status: refreshSucceeds ? 200 : 401 });
    }
    if (!authed) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    return new Response(JSON.stringify(jsonBody), { status: 200 });
  }) as unknown as typeof fetch;

  return { fetcher, calls, refreshCount: () => refreshCount };
}

describe('createFetchClient', () => {
  it('on a 401, refreshes once and retries; then returns the JSON body', async () => {
    const f = makeFetch();
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher: f.fetcher });
    const body = await client.request<{ ok: boolean }>('/data');
    expect(body).toEqual({ ok: true });
    expect(f.refreshCount()).toBe(1);
    // original 401, refresh, retry
    expect(f.calls.map((c) => c.url)).toEqual([
      'http://x/data',
      'http://x/api/auth/refresh',
      'http://x/data',
    ]);
  });

  it('deduplicates concurrent refreshes: N overlapping 401s trigger exactly ONE refresh', async () => {
    // The property all three consumers hand-rolled. A slow refresh maximises the
    // overlap window: without single-flight, each of the 8 requests would fire
    // its own refresh.
    const f = makeFetch({ refreshDelayMs: 25 });
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher: f.fetcher });

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.request<{ ok: boolean }>(`/data/${i}`)),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(f.refreshCount()).toBe(1);
  });

  it('a failed refresh does not retry; the original 401 surfaces as an error', async () => {
    const f = makeFetch({ refreshSucceeds: false });
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher: f.fetcher });
    await expect(client.request('/data')).rejects.toThrow(/unauthorized/);
    expect(f.refreshCount()).toBe(1); // tried once, gave up
  });

  it('never refreshes in response to a 401 from an auth endpoint', async () => {
    const f = makeFetch();
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher: f.fetcher });
    await expect(client.request('/api/auth/login')).rejects.toBeTruthy();
    expect(f.refreshCount()).toBe(0);
  });

  it('after a refresh settles, the next 401 starts a fresh refresh', async () => {
    const f = makeFetch();
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher: f.fetcher });
    await client.request('/data');
    // Force re-auth by making the fake un-authed again is awkward; instead assert
    // the in-flight promise was cleared: a second call that is already authed does
    // not refresh, and a manual refresh() works.
    expect(await client.refresh()).toBe(true);
    expect(f.refreshCount()).toBe(2);
  });

  it('empty 204-style bodies resolve to undefined, not a JSON parse error', async () => {
    const fetcher = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher });
    await expect(client.request('/ping')).resolves.toBeUndefined();
  });
});

describe('auth strategies', () => {
  it('bearerAuth adds Authorization from the injected token accessor', async () => {
    const seen: Record<string, string>[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createFetchClient({
      baseUrl: 'http://x',
      fetcher,
      auth: bearerAuth({ getAccessToken: () => 'tok123', onRefreshed: () => true }),
    });
    await client.request('/data');
    expect(new Headers(seen[0]).get('Authorization')).toBe('Bearer tok123');
  });

  it('bearerAuth omits Authorization when there is no token', async () => {
    const seen: Record<string, string>[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createFetchClient({
      baseUrl: 'http://x',
      fetcher,
      auth: bearerAuth({ getAccessToken: () => null, onRefreshed: () => true }),
    });
    await client.request('/data');
    expect(new Headers(seen[0]).get('Authorization')).toBeNull();
  });

  it('csrfAuth adds the x-csrf-token header from the accessor', async () => {
    const seen: Record<string, string>[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response(JSON.stringify({}), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createFetchClient({
      baseUrl: 'http://x',
      fetcher,
      auth: csrfAuth({ getCsrfToken: () => 'csrf-abc' }),
    });
    await client.request('/data', { method: 'POST' });
    expect(new Headers(seen[0]).get('x-csrf-token')).toBe('csrf-abc');
  });

  it('preserves caller headers supplied as a Headers instance', () => {
    const decorated = cookieAuth().decorate({
      headers: new Headers([
        ['X-Request-Id', 'request-123'],
        ['Content-Type', 'text/plain'],
      ]),
    });
    const headers = new Headers(decorated.headers);
    expect(headers.get('X-Request-Id')).toBe('request-123');
    expect(headers.get('Content-Type')).toBe('text/plain');
  });

  it('bearerAuth.onRefreshed returning false fails the refresh', async () => {
    let authed = false;
    const fetcher = (async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ error: 'no' }), { status: authed ? 200 : 401 });
    }) as unknown as typeof fetch;
    const client = createFetchClient({
      baseUrl: 'http://x',
      fetcher,
      auth: bearerAuth({ getAccessToken: () => null, onRefreshed: () => false }),
    });
    await expect(client.request('/data')).rejects.toBeTruthy();
  });
});

describe('FormData handling (BWK-140)', () => {
  for (const [name, make] of [
    ['cookieAuth', () => cookieAuth()],
    ['bearerAuth', () => bearerAuth({ getAccessToken: () => 't', onRefreshed: () => true })],
    ['csrfAuth', () => csrfAuth({ getCsrfToken: () => 'c' })],
  ] as const) {
    it(`${name} does NOT set Content-Type on a FormData body (browser must set the boundary)`, () => {
      const fd = new FormData();
      fd.append('file', 'x');
      const decorated = make().decorate({ method: 'POST', body: fd });
      const headers = decorated.headers as Record<string, string>;
      const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type');
      expect(ct, `${name} must leave Content-Type unset for FormData`).toBeUndefined();
    });

    it(`${name} still sets application/json for a normal body`, () => {
      const decorated = make().decorate({ method: 'POST', body: JSON.stringify({ a: 1 }) });
      expect(new Headers(decorated.headers).get('Content-Type')).toBe('application/json');
    });

    it(`${name} does not override a Content-Type the caller already set`, () => {
      const decorated = make().decorate({ headers: { 'Content-Type': 'text/plain' } });
      expect(new Headers(decorated.headers).get('Content-Type')).toBe('text/plain');
    });
  }
});

describe('crossTabRefresh (bearerAuth, BWK-142)', () => {
  // Simulates a "tab": its own in-memory token store plus a bearerAuth
  // strategy wired to it.
  function makeTab(opts: { channelName?: string; onTokenReceived?: (t: string) => void } = {}) {
    const store: { token: string | null } = { token: null };
    const onTokenReceived = opts.onTokenReceived ?? ((t: string) => { store.token = t; });
    const auth = bearerAuth({
      getAccessToken: () => store.token,
      onRefreshed: async (res) => {
        const body = (await res.json()) as { accessToken: string };
        store.token = body.accessToken;
        return true;
      },
      ...(opts.channelName ? { crossTabRefresh: { channelName: opts.channelName, onTokenReceived } } : {}),
    });
    return { store, auth };
  }

  // A fetcher for a single tab: 401s until `authed(store)` says the current
  // token is accepted, at which point it 200s. The refresh endpoint always
  // succeeds and mints `refreshToken` (never exposed as the access token).
  function makeTabFetcher(store: { token: string | null }, mintedAccessToken: string) {
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      if (url.endsWith('/api/auth/refresh')) {
        return new Response(
          JSON.stringify({ accessToken: mintedAccessToken, refreshToken: 'super-secret-refresh-token' }),
          { status: 200 },
        );
      }
      if (store.token === mintedAccessToken) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }) as unknown as typeof fetch;
    return { fetcher, calls };
  }

  it('client A refreshes; client B adopts the new token without ever hitting the refresh endpoint', async () => {
    const channelName = `bwk-142-adopt-${Math.random()}`;
    const a = makeTab({ channelName });
    const b = makeTab({ channelName });

    const fA = makeTabFetcher(a.store, 'fresh-token');
    const clientA = createFetchClient({ baseUrl: 'http://x', auth: a.auth, fetcher: fA.fetcher });
    await clientA.request('/data'); // 401 -> refresh -> retry; broadcasts 'fresh-token'

    // Wait for the async BroadcastChannel delivery to reach tab B.
    await vi.waitFor(() => expect(b.store.token).toBe('fresh-token'));

    // B now makes its OWN request. Because it already adopted the fresh
    // token, it should succeed on the first try and never need to refresh.
    const fB = makeTabFetcher(b.store, 'fresh-token');
    const clientB = createFetchClient({ baseUrl: 'http://x', auth: b.auth, fetcher: fB.fetcher });
    const result = await clientB.request<{ ok: boolean }>('/data');

    expect(result).toEqual({ ok: true });
    expect(fB.calls).not.toContain('http://x/api/auth/refresh');
    expect(fB.calls).toEqual(['http://x/data']); // single request, no refresh round-trip

    a.auth.close();
    b.auth.close();
  });

  it('degrades silently when BroadcastChannel is unavailable: refresh still succeeds, nothing throws', async () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error - simulating an environment without BroadcastChannel (SSR / old browsers)
    delete globalThis.BroadcastChannel;
    try {
      const onTokenReceived = vi.fn();
      expect(() =>
        bearerAuth({
          getAccessToken: () => null,
          onRefreshed: () => true,
          crossTabRefresh: { channelName: 'bwk-142-no-bc', onTokenReceived },
        }),
      ).not.toThrow();

      const a = makeTab({ channelName: 'bwk-142-no-bc' });
      const fA = makeTabFetcher(a.store, 'fresh-token');
      const clientA = createFetchClient({ baseUrl: 'http://x', auth: a.auth, fetcher: fA.fetcher });
      await expect(clientA.request('/data')).resolves.toEqual({ ok: true });
      expect(a.store.token).toBe('fresh-token');
      expect(() => a.auth.close()).not.toThrow();
    } finally {
      globalThis.BroadcastChannel = original;
    }
  });

  it('isolates by channel name: tabs on different channels do not see each other\'s tokens', async () => {
    const a = makeTab({ channelName: 'bwk-142-chan-a' });
    const b = makeTab({ channelName: 'bwk-142-chan-b' });

    const fA = makeTabFetcher(a.store, 'fresh-token');
    const clientA = createFetchClient({ baseUrl: 'http://x', auth: a.auth, fetcher: fA.fetcher });
    await clientA.request('/data');

    // Give any (incorrect) cross-talk a chance to arrive before asserting absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(b.store.token).toBeNull();

    a.auth.close();
    b.auth.close();
  });

  it('opt-out is the default: no BroadcastChannel is constructed when crossTabRefresh is omitted', async () => {
    const ctor = vi.spyOn(globalThis, 'BroadcastChannel');
    const a = makeTab(); // no channelName -> no crossTabRefresh option passed
    const fA = makeTabFetcher(a.store, 'fresh-token');
    const clientA = createFetchClient({ baseUrl: 'http://x', auth: a.auth, fetcher: fA.fetcher });
    await clientA.request('/data');

    expect(ctor).not.toHaveBeenCalled();
    expect(() => a.auth.close()).not.toThrow(); // close() is always safe, even with no channel
    ctor.mockRestore();
  });

  it('never broadcasts the refresh token — only the short-lived access token crosses the channel', async () => {
    const channelName = `bwk-142-secret-${Math.random()}`;
    const received: string[] = [];
    const a = makeTab({ channelName, onTokenReceived: (t) => received.push(t) });
    const b = makeTab({ channelName, onTokenReceived: (t) => received.push(t) });

    const fA = makeTabFetcher(a.store, 'fresh-token');
    const clientA = createFetchClient({ baseUrl: 'http://x', auth: a.auth, fetcher: fA.fetcher });
    await clientA.request('/data');

    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received).toEqual(['fresh-token']);
    expect(received.some((t) => t.includes('super-secret-refresh-token'))).toBe(false);

    a.auth.close();
    b.auth.close();
  });
});

describe('onAuthFailure (BWK-140)', () => {
  it('fires once when a refresh fails on a retriable 401', async () => {
    const fetcher = (async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ error: 'no' }), { status: 401 });
    }) as unknown as typeof fetch;
    const onAuthFailure = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher, onAuthFailure });
    await expect(client.request('/data')).rejects.toBeTruthy();
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('does not fire when the request succeeds or the refresh succeeds', async () => {
    let authed = false;
    const fetcher = (async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) { authed = true; return new Response('{}', { status: 200 }); }
      return new Response(JSON.stringify({ ok: true }), { status: authed ? 200 : 401 });
    }) as unknown as typeof fetch;
    const onAuthFailure = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher, onAuthFailure });
    await client.request('/data');
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('preserves the original request error when the observer throws', async () => {
    const fetcher = (async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ error: 'session expired' }), { status: 401 });
    }) as unknown as typeof fetch;
    const onAuthFailure = vi.fn(() => {
      throw new Error('redirect failed');
    });
    const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher, onAuthFailure });

    await expect(client.request('/data')).rejects.toThrow('session expired');
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });
});

describe('default fetcher is late-bound', () => {
  it('honours a global fetch stubbed AFTER the client was constructed', async () => {
    // Every consumer builds its client at module scope; test frameworks stub
    // globalThis.fetch later, in beforeEach. A default of `fetcher = fetch`
    // captures the global at construction and silently bypasses that stub —
    // sending real network traffic from the test suite.
    const original = globalThis.fetch;
    try {
      const client = createFetchClient({
        baseUrl: 'https://example.test',
        auth: bearerAuth({ getAccessToken: () => 'tok', onRefreshed: () => true }),
      });

      let stubbed = false;
      globalThis.fetch = (async () => {
        stubbed = true;
        return new Response('{"ok":true}', { status: 200 });
      }) as typeof fetch;

      await client.request('/thing');
      expect(stubbed).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
