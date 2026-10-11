import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createFetchClient, isAbortError, type AttemptContext, type AuthStrategy } from '../index';
import { upload, type UploadTransport } from '../upload';

afterEach(() => {
  vi.unstubAllGlobals();
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// A strategy whose token flips A -> B on a successful refresh; `credentialsFor`
// lets a test change the credentials mode between attempts.
function makeAuth(
  config: { gate?: { promise: Promise<boolean> }; credentialsFor?: (token: string) => RequestCredentials } = {},
) {
  const state = { token: 'A', refreshCalls: 0 };
  const auth: AuthStrategy = {
    decorate(request) {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${state.token}`);
      return { ...request, credentials: config.credentialsFor?.(state.token), headers };
    },
    async refresh() {
      state.refreshCalls += 1;
      const ok = config.gate ? await config.gate.promise : true;
      if (ok) state.token = 'B';
      return ok;
    },
  };
  return { auth, state };
}

const authorizationOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('authorization');

// 401 until the request carries the refreshed token.
const fetcherByToken = () =>
  vi.fn(async (_url: unknown, init?: RequestInit) =>
    authorizationOf(init) === 'Bearer B'
      ? new Response('{"ok":true}', { status: 200 })
      : new Response('{"error":"nope"}', { status: 401 }),
  );

describe('client.exchange (the public seam)', () => {
  it('re-decorates the ORIGINAL input on every attempt: token A, then token B after the refresh', async () => {
    const { auth, state } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: fetcherByToken() as unknown as typeof fetch });
    const seen: Array<string | null> = [];

    const response = await client.exchange('/p', ({ url, fetcher, decorate }) => {
      const init = decorate({ method: 'PUT', headers: { 'X-Intent': '1' } });
      seen.push(authorizationOf(init));
      return fetcher(url, init);
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual(['Bearer A', 'Bearer B']);
    expect(state.refreshCalls).toBe(1);
  });

  it('hands every attempt the resolved URL and the injected fetcher, not the global fetch', async () => {
    const injected = fetcherByToken();
    const global = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', global);
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://base', auth, fetcher: injected as unknown as typeof fetch });
    const contexts: AttemptContext[] = [];

    await client.exchange('/some/path', (context) => {
      contexts.push(context);
      return context.fetcher(context.url, context.decorate({}));
    });

    expect(contexts.map((c) => c.url)).toEqual(['http://base/some/path', 'http://base/some/path']);
    expect(contexts.every((c) => c.fetcher === contexts[0]!.fetcher)).toBe(true);
    expect(injected).toHaveBeenCalledTimes(2);
    expect(global).not.toHaveBeenCalled();
  });

  it('the default fetcher is late-bound: a global fetch stubbed AFTER the client was built is used', async () => {
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });
    const stub = fetcherByToken();
    vi.stubGlobal('fetch', stub);

    await client.exchange('/p', ({ url, fetcher, decorate }) => fetcher(url, decorate({})));

    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('returns a non-ok Response unread and never calls parseError', async () => {
    const parseError = vi.fn(async () => new Error('should not be built'));
    const { auth, state } = makeAuth();
    const client = createFetchClient({
      baseUrl: 'http://x',
      auth,
      parseError,
      fetcher: (async () => new Response('teapot', { status: 418 })) as unknown as typeof fetch,
    });

    const response = await client.exchange('/p', ({ url, fetcher, decorate }) => fetcher(url, decorate({})));

    expect(response.status).toBe(418);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('teapot');
    expect(parseError).not.toHaveBeenCalled();
    expect(state.refreshCalls).toBe(0);
  });

  it('guard: beforeRetry runs before the refresh and again before the resend; a pre-aborted guard signal stops before the refresh', async () => {
    const { auth, state } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: fetcherByToken() as unknown as typeof fetch });
    const calls: string[] = [];
    const attempt = ({ url, fetcher, decorate }: AttemptContext) => {
      calls.push('attempt');
      return fetcher(url, decorate({}));
    };

    await client.exchange('/p', attempt, { beforeRetry: () => calls.push('beforeRetry') });
    expect(calls).toEqual(['attempt', 'beforeRetry', 'beforeRetry', 'attempt']);

    const controller = new AbortController();
    controller.abort();
    const { auth: auth2, state: state2 } = makeAuth();
    const client2 = createFetchClient({ baseUrl: 'http://x', auth: auth2, fetcher: fetcherByToken() as unknown as typeof fetch });
    const error = await client2.exchange('/p', attempt, { signal: controller.signal }).catch((e) => e);
    expect(isAbortError(error)).toBe(true);
    expect(state2.refreshCalls).toBe(0);
    expect(state.refreshCalls).toBe(1);
  });

  it('request() takes no upload guards: it still refreshes and resends once', async () => {
    const { auth, state } = makeAuth();
    const fetcher = fetcherByToken();
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: fetcher as unknown as typeof fetch });

    expect(await client.request('/data')).toEqual({ ok: true });
    expect(state.refreshCalls).toBe(1);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://x/data', 'http://x/data']);
  });
});

describe('upload() on the exchange seam', () => {
  it('without a transport and without XMLHttpRequest, sends through the INJECTED fetcher at the resolved URL, not the global fetch', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined);
    const global = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', global);
    const injected = fetcherByToken();
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://base', auth, fetcher: injected as unknown as typeof fetch });

    expect(await upload(client, { path: '/photo', method: 'PUT', body: 'x' })).toEqual({ ok: true });

    expect(injected.mock.calls.map(([url]) => url)).toEqual(['http://base/photo', 'http://base/photo']);
    expect(global).not.toHaveBeenCalled();
  });

  it('chooses the transport from the credentials of EACH attempt: include (XHR) before the refresh, omit (fetch) after', async () => {
    const xhrs: Array<{ url: string }> = [];
    class StubXhr {
      url = '';
      status = 0;
      statusText = '';
      responseText = '';
      withCredentials = false;
      upload = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      constructor() {
        xhrs.push(this);
      }
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      getAllResponseHeaders() {
        return '';
      }
      send() {
        this.status = 401;
        this.responseText = '{"error":"nope"}';
        queueMicrotask(() => this.onload?.());
      }
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', StubXhr);
    const injected = fetcherByToken();
    const { auth } = makeAuth({ credentialsFor: (token) => (token === 'A' ? 'include' : 'omit') });
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: injected as unknown as typeof fetch });

    expect(await upload(client, { path: '/p', method: 'PUT', body: 'x' })).toEqual({ ok: true });

    expect(xhrs).toHaveLength(1);
    expect(injected).toHaveBeenCalledTimes(1);
    expect(injected.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' });
  });

  it('an explicit transport wins on every attempt, whatever the credentials', async () => {
    const { auth } = makeAuth({ credentialsFor: (token) => (token === 'A' ? 'include' : 'omit') });
    const injected = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: injected as unknown as typeof fetch });
    const transport = vi.fn<UploadTransport>(async (request) =>
      request.headers.authorization === 'Bearer B'
        ? new Response('{}', { status: 200 })
        : new Response('{}', { status: 401 }),
    );

    await upload(client, { transport, path: '/p', method: 'PUT', body: 'x' });

    expect(transport.mock.calls.map(([r]) => r.credentials)).toEqual(['include', 'omit']);
    expect(injected).not.toHaveBeenCalled();
  });

  for (const fence of ['before the refresh', 'after the refresh'] as const) {
    it(`a guard that aborts the signal and then throws a sentinel ${fence}: the sentinel's identity survives, not an AbortError`, async () => {
      const gate = deferred<boolean>();
      const { auth, state } = makeAuth({ gate });
      const onAuthFailure = vi.fn();
      const client = createFetchClient({
        baseUrl: 'http://x',
        auth,
        onAuthFailure,
        fetcher: fetcherByToken() as unknown as typeof fetch,
      });
      const controller = new AbortController();
      const sentinel = new Error('sentinel');
      let calls = 0;
      const failAt = fence === 'before the refresh' ? 1 : 2;

      const pending = upload(client, {
        path: '/p',
        method: 'PUT',
        body: 'x',
        signal: controller.signal,
        beforeRetry: () => {
          calls += 1;
          if (calls === failAt) {
            controller.abort();
            throw sentinel;
          }
        },
      }).catch((e) => e);
      await flush();
      gate.resolve(true);

      expect(await pending).toBe(sentinel);
      expect(state.refreshCalls).toBe(fence === 'before the refresh' ? 0 : 1);
      expect(onAuthFailure).not.toHaveBeenCalled();
    });
  }

  it('a custom parseError error is rejected by identity, not wrapped', async () => {
    const custom = new Error('custom');
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, parseError: async () => custom });

    const error = await upload(client, {
      transport: async () => new Response('x', { status: 418 }),
      path: '/p',
      method: 'PUT',
      body: 'x',
    }).catch((e) => e);

    expect(error).toBe(custom);
  });

  it('a parseError that rejects surfaces its own rejection, not a normalized one', async () => {
    const failure = new RangeError('parser blew up');
    const { auth } = makeAuth();
    const client = createFetchClient({
      baseUrl: 'http://x',
      auth,
      parseError: async () => {
        throw failure;
      },
    });

    const error = await upload(client, {
      transport: async () => new Response('x', { status: 500 }),
      path: '/p',
      method: 'PUT',
      body: 'x',
    }).catch((e) => e);

    expect(error).toBe(failure);
  });

  it('an abort during a custom parseError that never settles rejects promptly with the AbortError', async () => {
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, parseError: () => new Promise<Error>(() => undefined) });
    const controller = new AbortController();
    const reason = new Error('user cancelled');

    const pending = upload(client, {
      transport: async () => new Response('x', { status: 500 }),
      path: '/p',
      method: 'PUT',
      body: 'x',
      signal: controller.signal,
    }).catch((e) => e);
    await flush();
    controller.abort(reason);
    const error = await pending;

    expect(isAbortError(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(reason);
  });
});

describe('package entry points', () => {
  // Node resolves the package's own name through `exports`, the way a consumer does.
  const nodeRequire = createRequire(__filename);

  it('the root resolves createFetchClient and isAbortError, and carries no upload surface', () => {
    const root = nodeRequire('@andrewpopov/fetch-client-kit') as Record<string, unknown>;
    expect(typeof root.createFetchClient).toBe('function');
    expect(typeof root.isAbortError).toBe('function');
    for (const removed of ['upload', 'xhrUploadTransport', 'fetchUploadTransport']) {
      expect(root[removed]).toBeUndefined();
    }
  });

  it('the /upload subpath resolves upload, both transports and the SAME isAbortError as the root', () => {
    const root = nodeRequire('@andrewpopov/fetch-client-kit') as Record<string, unknown>;
    const sub = nodeRequire('@andrewpopov/fetch-client-kit/upload') as Record<string, unknown>;
    for (const name of ['upload', 'xhrUploadTransport', 'fetchUploadTransport', 'isAbortError']) {
      expect(typeof sub[name]).toBe('function');
    }
    expect(sub.isAbortError).toBe(root.isAbortError);
  });

  it('the built core module never references the upload code', () => {
    const core = readFileSync(join(__dirname, '../../dist/index.js'), 'utf8');
    expect(core).not.toContain('XMLHttpRequest');
    expect(core).not.toContain('xhrUploadTransport');
    expect(core).not.toMatch(/require\(["']\.\/upload["']\)/);
    const cancellation = readFileSync(join(__dirname, '../../dist/cancellation.js'), 'utf8');
    expect(cancellation).not.toContain('XMLHttpRequest');
  });
});
