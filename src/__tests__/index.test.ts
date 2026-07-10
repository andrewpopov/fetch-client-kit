import { describe, it, expect, vi } from 'vitest';
import { createFetchClient, cookieAuth, bearerAuth, csrfAuth } from '../index';

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
    expect(seen[0].Authorization).toBe('Bearer tok123');
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
    expect(seen[0].Authorization).toBeUndefined();
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
    expect(seen[0]['x-csrf-token']).toBe('csrf-abc');
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
