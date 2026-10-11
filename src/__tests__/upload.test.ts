import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  createFetchClient,
  cookieAuth,
  fetchUploadTransport,
  isAbortError,
  xhrUploadTransport,
  type AuthStrategy,
  type UploadSendRequest,
  type UploadTransport,
} from '../index';

afterEach(() => {
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// A strategy whose token flips A -> B on a successful refresh, so a resend that
// reuses stale headers is visible. `gate` holds the refresh open until released.
function makeAuth(
  config: { gate?: { promise: Promise<boolean> }; refreshResult?: boolean; credentials?: RequestCredentials } = {},
) {
  const state = { token: 'A', refreshCalls: 0 };
  const auth: AuthStrategy = {
    decorate(request) {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${state.token}`);
      return { ...request, credentials: config.credentials, headers };
    },
    async refresh() {
      state.refreshCalls += 1;
      const ok = config.gate ? await config.gate.promise : (config.refreshResult ?? true);
      if (ok) state.token = 'B';
      return ok;
    },
  };
  return { auth, state };
}

// Answers 401 until the request carries the refreshed token.
function makeTransport(order: string[] = []) {
  const requests: UploadSendRequest[] = [];
  const transport: UploadTransport = async (request) => {
    requests.push(request);
    order.push('upload');
    const fresh = request.headers.authorization === 'Bearer B';
    return fresh ? new Response('{"ok":true}', { status: 200 }) : new Response('{"error":"nope"}', { status: 401 });
  };
  return { transport, requests };
}

const blob = () => new Blob(['bytes'], { type: 'image/png' });

describe('upload: the shared 401 -> refresh -> resend loop', () => {
  it('★1 refreshes and resends once; call order is [upload, refresh, upload] with the same body', async () => {
    const order: string[] = [];
    const { auth, state } = makeAuth();
    const originalRefresh = auth.refresh;
    auth.refresh = (ctx) => {
      order.push('refresh');
      return originalRefresh(ctx);
    };
    const { transport, requests } = makeTransport(order);
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });
    const body = blob();

    const result = await client.upload<{ ok: boolean }>({ path: '/photo', method: 'PUT', body });

    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['upload', 'refresh', 'upload']);
    expect(state.refreshCalls).toBe(1);
    expect(requests[0]?.body).toBe(body);
    expect(requests[1]?.body).toBe(body);
    expect(requests[0]?.url).toBe('http://x/photo');
  });

  it('decorates on EVERY attempt: token A first, token B after the refresh, same body', async () => {
    const { auth } = makeAuth();
    const { transport, requests } = makeTransport();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });
    const body = blob();

    await client.upload({ path: '/p', method: 'PUT', body, headers: { 'Idempotency-Key': 'intent-1' } });

    expect(requests.map((r) => r.headers.authorization)).toEqual(['Bearer A', 'Bearer B']);
    expect(requests.map((r) => r.headers['idempotency-key'])).toEqual(['intent-1', 'intent-1']);
    expect(requests[0]?.body).toBe(requests[1]?.body);
  });

  it('★2 a request() 401 and an upload() 401 in flight together trigger ONE refresh', async () => {
    const gate = deferred<boolean>();
    const { auth, state } = makeAuth({ gate });
    const { transport } = makeTransport();
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const fresh = new Headers(init?.headers).get('authorization') === 'Bearer B';
      return fresh ? new Response('{"ok":true}', { status: 200 }) : new Response('{}', { status: 401 });
    }) as unknown as typeof fetch;
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher, uploadTransport: transport });

    const pending = Promise.all([
      client.request('/data'),
      client.upload({ path: '/photo', method: 'PUT', body: blob() }),
    ]);
    await flush();
    expect(state.refreshCalls).toBe(1);
    gate.resolve(true);
    await pending;
    expect(state.refreshCalls).toBe(1);
  });

  it('a failed refresh fires onAuthFailure ONCE across concurrent uploads and a request', async () => {
    const gate = deferred<boolean>();
    const { auth } = makeAuth({ gate });
    const { transport } = makeTransport();
    const fetcher = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as unknown as typeof fetch;
    const onAuthFailure = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher, uploadTransport: transport, onAuthFailure });

    const settled = Promise.allSettled([
      client.upload({ path: '/a', method: 'PUT', body: blob() }),
      client.upload({ path: '/b', method: 'PUT', body: blob() }),
      client.upload({ path: '/c', method: 'PUT', body: blob() }),
      client.request('/d'),
    ]);
    await flush();
    gate.resolve(false);
    const results = await settled;

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect((results[0] as PromiseRejectedResult).reason).toMatchObject({ status: 401 });
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('never refreshes in response to a 401 from an auth path', async () => {
    const { auth, state } = makeAuth();
    const { transport, requests } = makeTransport();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });

    await expect(client.upload({ path: '/api/auth/avatar', method: 'POST', body: blob() })).rejects.toMatchObject({
      status: 401,
    });
    expect(state.refreshCalls).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('a second 401 after the resend surfaces as the error: one refresh, one resend', async () => {
    const { auth, state } = makeAuth();
    const transport = vi.fn<UploadTransport>(async () => new Response('{"error":"still no"}', { status: 401 }));
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });

    await expect(client.upload({ path: '/p', method: 'PUT', body: blob() })).rejects.toThrow('still no');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(state.refreshCalls).toBe(1);
  });
});

describe('upload: cancellation', () => {
  it('★3 a pre-aborted signal rejects with AbortError and never calls the transport', async () => {
    const { auth } = makeAuth();
    const transport = vi.fn<UploadTransport>();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });
    const controller = new AbortController();
    controller.abort();

    const error = await client.upload({ path: '/p', method: 'PUT', body: blob(), signal: controller.signal }).catch((e) => e);

    expect(isAbortError(error)).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it('a custom abort reason is kept as `cause` only; the rejection is still a named AbortError', async () => {
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: vi.fn<UploadTransport>() });
    const reason = new Error('user navigated away');
    const controller = new AbortController();
    controller.abort(reason);

    const error = await client.upload({ path: '/p', method: 'PUT', body: blob(), signal: controller.signal }).catch((e) => e);

    expect(error).not.toBe(reason);
    expect(isAbortError(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(reason);
  });

  it('falls back to an Error named AbortError where DOMException does not exist', async () => {
    vi.stubGlobal('DOMException', undefined);
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: vi.fn<UploadTransport>() });
    const controller = new AbortController();
    controller.abort();

    const error = await client.upload({ path: '/p', method: 'PUT', body: blob(), signal: controller.signal }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });

  it('the fetch transport normalizes a native fetch abort (custom reason) to an AbortError', async () => {
    const controller = new AbortController();
    const fetcher = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as unknown as typeof fetch;
    const reason = new Error('custom');
    const transport = fetchUploadTransport(fetcher);

    const pending = transport({ url: 'http://x/p', method: 'PUT', headers: {}, body: blob(), signal: controller.signal });
    controller.abort(reason);
    const error = await pending.catch((e) => e);

    expect(isAbortError(error)).toBe(true);
    expect((error as { cause?: unknown }).cause).toBe(reason);
  });

  it('the fetch transport normalizes an AbortError thrown by fetch with no abort on our signal', async () => {
    const fetcher = (async () => {
      throw new DOMException('timed out', 'AbortError');
    }) as unknown as typeof fetch;
    const error = await fetchUploadTransport(fetcher)({ url: 'http://x', method: 'PUT', headers: {}, body: 'x' }).catch((e) => e);
    expect(isAbortError(error)).toBe(true);
    expect((error as Error).message).toBe('Upload cancelled');
  });

  it('★5a identity changes while the refresh is pending: a SUCCESSFUL refresh does not resend', async () => {
    const gate = deferred<boolean>();
    const { auth, state } = makeAuth({ gate });
    const { transport, requests } = makeTransport();
    const onAuthFailure = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport, onAuthFailure });
    let epoch = 1;
    const captured = epoch;
    const stale = new Error('session_changed');

    const pending = client
      .upload({
        path: '/p',
        method: 'PUT',
        body: blob(),
        beforeRetry: () => {
          if (epoch !== captured) throw stale;
        },
      })
      .catch((e) => e);
    await flush();
    expect(state.refreshCalls).toBe(1);
    epoch = 2;
    gate.resolve(true);

    expect(await pending).toBe(stale);
    expect(requests).toHaveLength(1);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('★5b identity changes while the refresh is pending: a FAILED refresh does not fire onAuthFailure', async () => {
    const gate = deferred<boolean>();
    const { auth } = makeAuth({ gate });
    const { transport, requests } = makeTransport();
    const onAuthFailure = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport, onAuthFailure });
    let epoch = 1;
    const captured = epoch;
    const stale = new Error('session_changed');

    const pending = client
      .upload({
        path: '/p',
        method: 'PUT',
        body: blob(),
        beforeRetry: () => {
          if (epoch !== captured) throw stale;
        },
      })
      .catch((e) => e);
    await flush();
    epoch = 2;
    gate.resolve(false);

    expect(await pending).toBe(stale);
    expect(requests).toHaveLength(1);
    expect(onAuthFailure).not.toHaveBeenCalled();
  });

  it('beforeRetry throwing BEFORE the refresh stops it: no refresh, no resend, error passes through unchanged', async () => {
    const { auth, state } = makeAuth();
    const { transport, requests } = makeTransport();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });
    const stop = new Error('stop');

    const error = await client
      .upload({
        path: '/p',
        method: 'PUT',
        body: blob(),
        beforeRetry: () => {
          throw stop;
        },
      })
      .catch((e) => e);

    expect(error).toBe(stop);
    expect(state.refreshCalls).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('abort while the refresh is unresolved rejects promptly, then settling it has no later side effects', async () => {
    for (const outcome of [true, false]) {
      const gate = deferred<boolean>();
      const { auth, state } = makeAuth({ gate });
      const { transport, requests } = makeTransport();
      const onAuthFailure = vi.fn();
      const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport, onAuthFailure });
      const controller = new AbortController();

      const pending = client.upload({ path: '/p', method: 'PUT', body: blob(), signal: controller.signal }).catch((e) => e);
      await flush();
      expect(state.refreshCalls).toBe(1);
      controller.abort(new Error('custom reason'));

      const error = await pending; // settles WITHOUT the gate being released
      expect(isAbortError(error)).toBe(true);
      gate.resolve(outcome);
      await flush();

      expect(requests).toHaveLength(1);
      expect(onAuthFailure).not.toHaveBeenCalled();
    }
  });

  it('★5c an aborted waiter does not cancel or suppress the shared refresh for a live waiter (success)', async () => {
    const gate = deferred<boolean>();
    const { auth, state } = makeAuth({ gate });
    const { transport, requests } = makeTransport();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport });
    const controller = new AbortController();

    const dying = client.upload({ path: '/a', method: 'PUT', body: blob(), signal: controller.signal }).catch((e) => e);
    const live = client.upload<{ ok: boolean }>({ path: '/b', method: 'PUT', body: blob() });
    await flush();
    controller.abort();
    expect(isAbortError(await dying)).toBe(true);
    gate.resolve(true);

    expect(await live).toEqual({ ok: true });
    expect(state.refreshCalls).toBe(1);
    expect(requests.filter((r) => r.url.endsWith('/a'))).toHaveLength(1);
    expect(requests.filter((r) => r.url.endsWith('/b'))).toHaveLength(2);
  });

  it('★5d a stale waiter does not suppress onAuthFailure for the live waiter on a failed shared refresh', async () => {
    const gate = deferred<boolean>();
    const { auth } = makeAuth({ gate });
    const { transport } = makeTransport();
    const onAuthFailure = vi.fn();
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport, onAuthFailure });
    let epoch = 1;
    const captured = epoch;

    const stale = client
      .upload({
        path: '/a',
        method: 'PUT',
        body: blob(),
        beforeRetry: () => {
          if (epoch !== captured) throw new Error('session_changed');
        },
      })
      .catch((e) => e);
    const live = client.upload({ path: '/b', method: 'PUT', body: blob() }).catch((e) => e);
    await flush();
    epoch = 2;
    gate.resolve(false);

    expect(((await stale) as Error).message).toBe('session_changed');
    expect(await live).toMatchObject({ status: 401 });
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });
});

describe('upload: results and errors', () => {
  it('uses the custom parseError for a non-ok response', async () => {
    const { auth } = makeAuth();
    const transport: UploadTransport = async () => new Response('teapot', { status: 418 });
    const parseError = async (response: Response) => new Error(`custom ${response.status}`);
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: transport, parseError });

    await expect(client.upload({ path: '/p', method: 'PUT', body: 'x' })).rejects.toThrow('custom 418');
  });

  it('a 204 resolves to undefined and invalid 2xx JSON rejects with a SyntaxError', async () => {
    const { auth } = makeAuth();
    let next: Response = new Response(null, { status: 204 });
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: async () => next });

    expect(await client.upload({ path: '/p', method: 'PUT', body: 'x' })).toBeUndefined();
    next = new Response('<html>', { status: 200 });
    await expect(client.upload({ path: '/p', method: 'PUT', body: 'x' })).rejects.toBeInstanceOf(SyntaxError);
  });

  it('a network failure rejects with the transport TypeError and does not refresh', async () => {
    const { auth, state } = makeAuth();
    const failure = new TypeError('Network request failed');
    const client = createFetchClient({
      baseUrl: 'http://x',
      auth,
      uploadTransport: async () => {
        throw failure;
      },
    });

    await expect(client.upload({ path: '/p', method: 'PUT', body: 'x' })).rejects.toBe(failure);
    expect(state.refreshCalls).toBe(0);
  });
});

// --- XHR transport -------------------------------------------------------------

class FakeXhr {
  static instances: FakeXhr[] = [];
  method = '';
  url = '';
  headers: Record<string, string> = {};
  withCredentials = false;
  body: unknown;
  abortCalls = 0;
  status = 0;
  statusText = '';
  responseText = '';
  responseHeaders = '';
  upload: { onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.abortCalls += 1;
    this.onabort?.();
  }
  getAllResponseHeaders() {
    return this.responseHeaders;
  }
  respond(status: number, text: string, headers = '') {
    this.status = status;
    this.statusText = 'STATUS';
    this.responseText = text;
    this.responseHeaders = headers;
    this.onload?.();
  }
}

function stubXhr() {
  FakeXhr.instances = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
}

describe('xhrUploadTransport', () => {
  it('sends method, url and body; withCredentials only for include; skips content-length; keeps auth headers', async () => {
    stubXhr();
    const send = async (credentials: RequestCredentials) => {
      const { auth } = makeAuth({ credentials });
      const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: xhrUploadTransport() });
      const body = blob();
      const pending = client.upload({
        path: '/photo',
        method: 'PUT',
        body,
        headers: { 'Content-Length': '5', 'X-Thing': 'y' },
      });
      await flush();
      const xhr = FakeXhr.instances.at(-1)!;
      xhr.respond(200, '{"ok":true}', 'content-type: application/json\r\n');
      await pending;
      return { xhr, body };
    };

    const included = await send('include');
    expect(included.xhr.withCredentials).toBe(true);
    expect(included.xhr.method).toBe('PUT');
    expect(included.xhr.url).toBe('http://x/photo');
    expect(included.xhr.body).toBe(included.body);
    expect(included.xhr.headers.authorization).toBe('Bearer A');
    expect(included.xhr.headers['x-thing']).toBe('y');
    expect(included.xhr.headers['content-length']).toBeUndefined();

    expect((await send('same-origin')).xhr.withCredentials).toBe(false);
  });

  it('credentials: omit goes through fetch (XHR cannot omit), without constructing an XHR', async () => {
    stubXhr();
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const { auth } = makeAuth({ credentials: 'omit' });
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: fetcher as unknown as typeof fetch });

    await client.upload({ path: '/p', method: 'PUT', body: 'x' });

    expect(FakeXhr.instances).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'omit', method: 'PUT' });
  });

  it('credentials: include and same-origin use the XHR default transport', async () => {
    for (const credentials of ['include', 'same-origin'] as const) {
      stubXhr();
      const fetcher = vi.fn();
      const { auth } = makeAuth({ credentials });
      const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: fetcher as unknown as typeof fetch });
      const pending = client.upload({ path: '/p', method: 'PUT', body: 'x' });
      await flush();
      FakeXhr.instances[0]!.respond(200, '{}');
      await pending;
      expect(fetcher).not.toHaveBeenCalled();
    }
  });

  it('reports progress, with an unknown total as undefined', async () => {
    stubXhr();
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });
    const onProgress = vi.fn();
    const pending = client.upload({ path: '/p', method: 'PUT', body: blob(), onProgress });
    await flush();
    const xhr = FakeXhr.instances[0]!;
    xhr.upload.onprogress?.({ loaded: 2, total: 10, lengthComputable: true });
    xhr.upload.onprogress?.({ loaded: 4, total: 0, lengthComputable: false });
    xhr.respond(200, '{}');
    await pending;

    expect(onProgress.mock.calls).toEqual([[{ loaded: 2, total: 10 }], [{ loaded: 4, total: undefined }]]);
  });

  it('a status-0 load and an onerror both reject with a TypeError', async () => {
    stubXhr();
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });

    const first = client.upload({ path: '/p', method: 'PUT', body: 'x' }).catch((e) => e);
    await flush();
    FakeXhr.instances[0]!.respond(0, '');
    expect(await first).toBeInstanceOf(TypeError);

    const second = client.upload({ path: '/p', method: 'PUT', body: 'x' }).catch((e) => e);
    await flush();
    FakeXhr.instances[1]!.onerror?.();
    expect(await second).toBeInstanceOf(TypeError);
  });

  it('a 204 over XHR resolves to undefined (null-body Response)', async () => {
    stubXhr();
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });
    const pending = client.upload({ path: '/p', method: 'PUT', body: 'x' });
    await flush();
    FakeXhr.instances[0]!.respond(204, '');
    expect(await pending).toBeUndefined();
  });

  it('★4 aborting mid-flight calls xhr.abort() and rejects with AbortError, and the listener is removed after settle', async () => {
    stubXhr();
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });
    const controller = new AbortController();

    const pending = client.upload({ path: '/p', method: 'PUT', body: blob(), signal: controller.signal }).catch((e) => e);
    await flush();
    controller.abort(new Error('custom'));
    const error = await pending;

    expect(FakeXhr.instances[0]!.abortCalls).toBeGreaterThanOrEqual(1);
    expect(isAbortError(error)).toBe(true);

    // A signal that aborts AFTER a normal completion must not touch the finished XHR.
    const second = new AbortController();
    const done = client.upload({ path: '/p', method: 'PUT', body: blob(), signal: second.signal });
    await flush();
    const xhr = FakeXhr.instances[1]!;
    xhr.respond(200, '{}');
    await done;
    second.abort();
    expect(xhr.abortCalls).toBe(0);
  });

  it('a pre-aborted signal never constructs an XHR', async () => {
    stubXhr();
    const controller = new AbortController();
    controller.abort();
    const error = await xhrUploadTransport()({
      url: 'http://x',
      method: 'PUT',
      headers: {},
      body: 'x',
      signal: controller.signal,
    }).catch((e) => e);
    expect(isAbortError(error)).toBe(true);
    expect(FakeXhr.instances).toHaveLength(0);
  });
});

describe('xhrUploadTransport hardening', () => {
  it('an explicitly supplied xhrUploadTransport rejects credentials: omit before constructing an XHR', async () => {
    stubXhr();
    const { auth } = makeAuth({ credentials: 'omit' });
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: xhrUploadTransport() });

    await expect(client.upload({ path: '/p', method: 'PUT', body: 'x' })).rejects.toThrow(/credentials: 'omit'/);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it('a response that cannot be built (status 600) rejects, and the abort listener is removed', async () => {
    stubXhr();
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });
    const controller = new AbortController();

    const pending = client.upload({ path: '/p', method: 'PUT', body: 'x', signal: controller.signal }).catch((e) => e);
    await flush();
    const xhr = FakeXhr.instances[0]!;
    expect(() => xhr.respond(600, '')).not.toThrow();
    expect(await pending).toBeInstanceOf(RangeError);
    controller.abort();
    expect(xhr.abortCalls).toBe(0);
  });
});

describe('upload: cancel while the response body is being read', () => {
  // Headers arrive at once; the body never completes until the signal aborts, then errors with its reason.
  function stalledBody(status: number, signal: AbortSignal): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason));
      },
    });
    return new Response(stream, { status });
  }

  for (const status of [200, 500]) {
    it(`a ${status} aborted mid-body rejects with the normalized AbortError and the custom reason as cause`, async () => {
      const { auth } = makeAuth();
      const controller = new AbortController();
      const client = createFetchClient({
        baseUrl: 'http://x',
        auth,
        uploadTransport: async () => stalledBody(status, controller.signal),
      });
      const reason = new Error('user cancelled');

      const pending = client.upload({ path: '/p', method: 'PUT', body: 'x', signal: controller.signal }).catch((e) => e);
      await flush();
      controller.abort(reason);
      const error = await pending;

      expect(isAbortError(error)).toBe(true);
      expect((error as { status?: number }).status).toBeUndefined();
      expect((error as { cause?: unknown }).cause).toBe(reason);
    });
  }

  it('an abort during a body read that never errors still rejects promptly', async () => {
    const { auth } = makeAuth();
    const controller = new AbortController();
    const hanging = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    const client = createFetchClient({ baseUrl: 'http://x', auth, uploadTransport: async () => hanging });

    const pending = client.upload({ path: '/p', method: 'PUT', body: 'x', signal: controller.signal }).catch((e) => e);
    await flush();
    controller.abort();
    expect(isAbortError(await pending)).toBe(true);
  });
});

describe('default upload transport selection', () => {
  it('is late-bound: an XMLHttpRequest stubbed AFTER the client was built is used', async () => {
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth });
    stubXhr();
    const pending = client.upload({ path: '/p', method: 'PUT', body: 'x' });
    await flush();
    expect(FakeXhr.instances).toHaveLength(1);
    FakeXhr.instances[0]!.respond(200, '{}');
    await pending;
  });

  it('falls back to the fetcher when XMLHttpRequest does not exist', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined);
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const { auth } = makeAuth();
    const client = createFetchClient({ baseUrl: 'http://x', auth, fetcher: fetcher as unknown as typeof fetch });

    expect(await client.upload({ path: '/p', method: 'PUT', body: 'x' })).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('Content-Type is not forced onto self-typed bodies (request and upload)', () => {
  const bodies: Array<[string, () => BodyInit]> = [
    ['Blob', () => new Blob(['x'], { type: 'image/png' })],
    ['ArrayBuffer', () => new ArrayBuffer(4)],
    ['Uint8Array', () => new Uint8Array(4)],
    ['URLSearchParams', () => new URLSearchParams({ a: '1' })],
    ['FormData', () => new FormData()],
  ];

  for (const [name, make] of bodies) {
    it(`request() leaves Content-Type unset for a ${name} body`, async () => {
      const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
      const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), fetcher: fetcher as unknown as typeof fetch });
      await client.request('/p', { method: 'POST', body: make() });
      const init = (fetcher.mock.calls[0] as unknown[])[1] as RequestInit;
      expect(new Headers(init.headers).has('content-type')).toBe(false);
    });

    it(`upload() leaves Content-Type unset for a ${name} body`, async () => {
      const transport = vi.fn<UploadTransport>(async () => new Response('{}', { status: 200 }));
      const client = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth(), uploadTransport: transport });
      await client.upload({ path: '/p', method: 'POST', body: make() as never });
      expect(transport.mock.calls[0]![0].headers['content-type']).toBeUndefined();
    });
  }

  it('a string body still defaults to application/json, and a caller-set type is kept, on both paths', async () => {
    const transport = vi.fn<UploadTransport>(async () => new Response('{}', { status: 200 }));
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const client = createFetchClient({
      baseUrl: 'http://x',
      auth: cookieAuth(),
      uploadTransport: transport,
      fetcher: fetcher as unknown as typeof fetch,
    });

    await client.upload({ path: '/p', method: 'POST', body: '{}' });
    await client.upload({ path: '/p', method: 'PUT', body: blob(), headers: { 'Content-Type': 'image/jpeg' } });
    await client.request('/p', { method: 'POST', body: '{}' });

    expect(transport.mock.calls[0]![0].headers['content-type']).toBe('application/json');
    expect(transport.mock.calls[1]![0].headers['content-type']).toBe('image/jpeg');
    expect(new Headers(((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).headers).get('content-type')).toBe(
      'application/json',
    );
  });
});

describe('isAbortError', () => {
  it('recognises a named AbortError and nothing else', () => {
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortError(new TypeError('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});
