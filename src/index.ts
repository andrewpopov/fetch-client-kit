// @andrewpopov/fetch-client-kit
//
// One implementation of a transport apps commonly hand-roll: a base-URL fetch
// wrapper that, on a 401, refreshes once and retries — deduplicating concurrent
// refreshes so N overlapping 401s trigger exactly ONE refresh. Consumers differ
// only in how auth attaches to a request (cookie, bearer, csrf header); that is
// the one pluggable seam, an AuthStrategy.

export interface AuthStrategy {
  /** Decorate an outgoing request: add an Authorization header, a CSRF header,
   * set credentials, etc. Returns the RequestInit to actually send. */
  decorate(request: RequestInit): RequestInit;
  /** Perform a token/session refresh. Resolves true if it succeeded, so the
   * original request can be retried. Never throws — a failed refresh is `false`. */
  refresh(context: RefreshContext): Promise<boolean>;
}

export interface RefreshContext {
  baseUrl: string;
  fetcher: typeof fetch;
}

export interface FetchClientOptions {
  baseUrl: string;
  auth: AuthStrategy;
  /** Injected for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
  /** Request paths (relative to baseUrl) that must NOT trigger a refresh-retry —
   * the auth endpoints themselves. Matched by prefix. Default: ['/api/auth/']. */
  authPathPrefixes?: string[];
  /** Turn a non-ok Response into the Error that `request` rejects with. Defaults
   * to reading a JSON `{ error }` body, falling back to the status text. */
  parseError?: (response: Response) => Promise<Error>;
  /** Called once when a refresh fails on a 401 (the retry could not proceed).
   * Use it to clear auth state and redirect to login. Never throws the caller's
   * error — the original request still rejects with its own error. */
  onAuthFailure?: () => void;
  /** How `upload` sends bytes. Defaults to `xhrUploadTransport()` when
   * `XMLHttpRequest` exists (it reports progress), otherwise
   * `fetchUploadTransport(fetcher)`. A request whose strategy asks for
   * `credentials: 'omit'` always goes through fetch by default, because XHR
   * cannot omit credentials on a same-origin request. An injected transport
   * is used as given and receives the `credentials` to honour. */
  uploadTransport?: UploadTransport;
}

export interface UploadProgress {
  loaded: number;
  /** Undefined when the browser cannot compute the total. */
  total: number | undefined;
}

export type UploadBody = Blob | FormData | ArrayBuffer | ArrayBufferView | URLSearchParams | string;

export interface UploadOptions {
  path: string;
  method: 'POST' | 'PUT' | 'PATCH';
  body: UploadBody;
  headers?: HeadersInit;
  /** Restarts from zero if the upload is resent after a refresh. */
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Called after a retriable 401, before the refresh and again before the
   * resend or `onAuthFailure`. Throw to stop: the throw rejects `upload`
   * unchanged, and neither the resend nor `onAuthFailure` happens for it. */
  beforeRetry?: () => void;
}

export interface UploadSendRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
  body: UploadBody;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** One attempt. Resolves a Response for any HTTP status; rejects with a
 * TypeError for a network failure or an AbortError when cancelled. Never retries. */
export type UploadTransport = (request: UploadSendRequest) => Promise<Response>;

export interface FetchClient {
  request<T>(path: string, options?: RequestInit): Promise<T>;
  /** Send a body through the same 401 -> refresh -> resend loop as `request`,
   * with a progress callback and cancellation. */
  upload<T>(options: UploadOptions): Promise<T>;
  /** Exposed for callers that need to force a refresh (e.g. on app focus). */
  refresh(): Promise<boolean>;
}

async function defaultParseError(response: Response): Promise<Error> {
  // The body is untrusted server output: valid JSON can still be `null`, an
  // array, or a string (e.g. `"null"`, `"[]"`, `'"nope"'` are all parseable),
  // none of which has `.error`/`.message` to read. Narrow to a plain object
  // before touching either property, or a literal JSON `null` body throws a
  // TypeError here that replaces the status-bearing Error this is supposed
  // to construct — the caller would see an unrelated crash instead of a
  // rejection carrying `.status`.
  const parsed: unknown = await response.json().catch(() => undefined);
  const body: { error?: unknown; message?: unknown } =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const message =
    (typeof body.error === 'string' && body.error) ||
    (typeof body.message === 'string' && body.message) ||
    response.statusText ||
    `Request failed (${response.status})`;
  const err = new Error(message);
  (err as Error & { status?: number }).status = response.status;
  return err;
}


// A FormData body must NOT get an explicit Content-Type: the browser sets it,
// including the multipart `boundary=` the server needs to parse the upload.
// Forcing application/json there silently corrupts every file upload. The same
// holds for every other body the platform types itself (a Blob's own type, form
// encoding for URLSearchParams); only text bodies default to JSON. Applies to
// every strategy, so it lives here.
function isSelfTypedBody(body: unknown): boolean {
  const is = (ctor: string) => {
    const c = (globalThis as Record<string, unknown>)[ctor];
    return typeof c === 'function' && body instanceof (c as new (...args: never[]) => object);
  };
  return (
    is('FormData') ||
    is('Blob') ||
    is('URLSearchParams') ||
    is('ReadableStream') ||
    is('ArrayBuffer') ||
    ArrayBuffer.isView(body)
  );
}

function withContentType(
  request: RequestInit,
  extra: Record<string, string> = {},
): Record<string, string> {
  // `HeadersInit` also permits a `Headers` instance and a tuple array. Spreading
  // either as an object silently drops header values, so normalize through the
  // platform constructor before applying strategy-owned headers.
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(extra)) {
    headers.set(name, value);
  }
  if (!isSelfTypedBody(request.body) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const normalized: Record<string, string> = {};
  headers.forEach((value, name) => {
    normalized[name] = value;
  });
  return normalized;
}

/** The one cancellation error `upload` rejects with, whatever aborted it. */
function cancelled(cause?: unknown): Error {
  const message = 'Upload cancelled';
  let error: Error;
  if (typeof DOMException === 'function') {
    error = new DOMException(message, 'AbortError');
  } else {
    error = new Error(message);
    error.name = 'AbortError';
  }
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true });
  return error;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled(signal.reason);
}

// Rejects as soon as `signal` aborts WITHOUT cancelling `promise`: the refresh is
// shared single-flight, so a cancelled waiter must not take it from live ones.
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled(signal.reason));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function toRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

const FORBIDDEN_XHR_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

function isForbiddenXhrHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    FORBIDDEN_XHR_HEADERS.has(lower) ||
    lower.startsWith('proxy-') ||
    lower.startsWith('sec-') ||
    lower.startsWith('access-control-request-')
  );
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Uploads over XMLHttpRequest, the only browser API that reports upload
 * progress. `XMLHttpRequest` is resolved on every call so a later stub is honoured. */
export function xhrUploadTransport(): UploadTransport {
  return (request) =>
    new Promise<Response>((resolve, reject) => {
      const { signal } = request;
      if (request.credentials === 'omit') {
        // XHR can only turn credentials off for cross-origin requests, so it cannot honour this.
        reject(new Error("xhrUploadTransport cannot honour credentials: 'omit'; use fetchUploadTransport"));
        return;
      }
      if (signal?.aborted) {
        reject(cancelled(signal.reason));
        return;
      }
      const xhr = new XMLHttpRequest();
      let settled = false;
      const onSignalAbort = () => {
        xhr.abort();
        settle(() => reject(cancelled(signal?.reason)));
      };
      function settle(finish: () => void) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onSignalAbort);
        finish();
      }

      try {
        xhr.open(request.method, request.url);
        for (const [name, value] of Object.entries(request.headers)) {
          if (!isForbiddenXhrHeader(name)) xhr.setRequestHeader(name, value);
        }
        xhr.withCredentials = request.credentials === 'include';
        if (request.onProgress) {
          const onProgress = request.onProgress;
          xhr.upload.onprogress = (event) =>
            onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined });
        }
        xhr.onload = () =>
          settle(() => {
            if (xhr.status < 200) {
              reject(new TypeError('Network request failed'));
              return;
            }
            const headers = new Headers();
            for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
              const split = line.indexOf(':');
              if (split > 0) headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim());
            }
            try {
              resolve(
                new Response(NULL_BODY_STATUSES.has(xhr.status) ? null : xhr.responseText, {
                  status: xhr.status,
                  statusText: xhr.statusText,
                  headers,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        xhr.onerror = () => settle(() => reject(new TypeError('Network request failed')));
        xhr.onabort = () => settle(() => reject(cancelled(signal?.reason)));
        signal?.addEventListener('abort', onSignalAbort, { once: true });
        xhr.send(request.body as XMLHttpRequestBodyInit);
      } catch (error) {
        settle(() => reject(error));
      }
    });
}

/** Uploads over fetch: no progress events, but it honours every `credentials` mode. */
export function fetchUploadTransport(fetcher: typeof fetch = (input, init) => fetch(input, init)): UploadTransport {
  return async (request) => {
    throwIfAborted(request.signal);
    try {
      return await fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        credentials: request.credentials,
        body: request.body as BodyInit,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw cancelled(request.signal.reason);
      if (isAbortError(error)) throw cancelled(error);
      throw error;
    }
  };
}

interface RetryGuard {
  signal?: AbortSignal;
  beforeRetry?: () => void;
}

export function createFetchClient(options: FetchClientOptions): FetchClient {
  const {
    baseUrl,
    auth,
    // Late-bound on purpose. `fetcher = fetch` would capture the CURRENT global
    // fetch at construction time — and every consumer builds its client at module
    // scope, before any test stubs `globalThis.fetch`. The client would then
    // bypass the stub and hit the real network, silently. Re-resolving the global
    // per call keeps the default late-bound so a later stub is honoured.
    fetcher = (input, init) => fetch(input, init),
    authPathPrefixes = ['/api/auth/'],
    parseError = defaultParseError,
    onAuthFailure,
  } = options;

  // Single-flight refresh: the FIRST 401 to arrive starts the refresh; every
  // other concurrent 401 awaits the SAME promise instead of firing its own. This
  // is the property all three consumers hand-rolled (and where they could each
  // drift into a bug). Cleared in `finally` so the next 401 after settle starts
  // fresh.
  let inFlightRefresh: Promise<boolean> | null = null;
  // `onAuthFailure` must fire once per *refresh attempt*, not once per waiter.
  // N concurrent 401s share the one `inFlightRefresh` promise above, but each
  // waiter's own `request()` continuation used to run its own `onAuthFailure()`
  // call after that shared promise settled — 8 concurrent 401s meant 8 calls to
  // a hook whose job is typically to wipe local state and redirect to login.
  // Reset alongside `inFlightRefresh` so the next attempt notifies again.
  let authFailureNotified = false;

  function refresh(): Promise<boolean> {
    if (!inFlightRefresh) {
      authFailureNotified = false;
      inFlightRefresh = auth
        .refresh({ baseUrl, fetcher })
        .catch(() => false)
        .finally(() => {
          inFlightRefresh = null;
        }) as Promise<boolean>;
    }
    return inFlightRefresh;
  }

  function shouldRetry(path: string, status: number): boolean {
    if (status !== 401) return false;
    // Never try to refresh in response to the refresh/login endpoint 401-ing.
    return !authPathPrefixes.some((prefix) => path.startsWith(prefix));
  }

  async function send(path: string, options: RequestInit): Promise<Response> {
    return fetcher(`${baseUrl}${path}`, auth.decorate(options));
  }

  // The 401 -> refresh -> resend loop, shared by `request` and `upload`. `attempt`
  // re-decorates from the caller's original input each time, so the resend carries
  // the refreshed credentials. The guard lets a cancelled or stale caller stop
  // before it refreshes, and again after the (shared, uncancellable) refresh
  // settles, so it never resends or fires `onAuthFailure` on a dead session.
  async function exchange(path: string, attempt: () => Promise<Response>, guard?: RetryGuard): Promise<Response> {
    const checkGuard = () => {
      throwIfAborted(guard?.signal);
      guard?.beforeRetry?.();
    };
    let response = await attempt();

    if (shouldRetry(path, response.status)) {
      checkGuard();
      const refreshed = await raceAbort(refresh(), guard?.signal);
      checkGuard();
      if (refreshed) {
        response = await attempt();
      } else if (onAuthFailure && !authFailureNotified) {
        // Guard so concurrent waiters on the same failed refresh notify once
        // (see `authFailureNotified` above), not once per waiter.
        authFailureNotified = true;
        // This is an observer hook. A redirect or state-cleanup error must not
        // replace the request error the caller needs to handle.
        try {
          onAuthFailure();
        } catch {
          // Preserve the original failed response below.
        }
      }
    }
    return response;
  }

  async function parsed<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw await parseError(response);
    }

    // 204 and empty bodies parse to undefined rather than throwing.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return parsed<T>(await exchange(path, () => send(path, options)));
  }

  const fetchTransport = fetchUploadTransport(fetcher);
  const xhrTransport = xhrUploadTransport();

  async function upload<T>(uploadOptions: UploadOptions): Promise<T> {
    const { path, method, body, headers, onProgress, signal, beforeRetry } = uploadOptions;
    throwIfAborted(signal);

    async function attempt(): Promise<Response> {
      const init = auth.decorate({ method, headers, body: body as BodyInit });
      const transport =
        options.uploadTransport ??
        (init.credentials === 'omit' || typeof XMLHttpRequest === 'undefined' ? fetchTransport : xhrTransport);
      return transport({
        url: `${baseUrl}${path}`,
        method,
        headers: toRecord(init.headers),
        credentials: init.credentials,
        body,
        onProgress,
        signal,
      });
    }

    const response = await exchange(path, attempt, { signal, beforeRetry });
    // fetch resolves at the headers, so a cancel can still land while the body
    // is read; `parseError` also swallows body-read failures into a status
    // error. Whatever surfaces after an abort is the cancellation.
    try {
      return await raceAbort(parsed<T>(response), signal);
    } catch (error) {
      if (signal?.aborted) throw cancelled(signal.reason);
      throw error;
    }
  }

  return { request, upload, refresh };
}

// --- Built-in auth strategies -------------------------------------------------

/** Cookie/session auth: send credentials, add JSON headers, and
 * refresh by POSTing to the refresh path. Nothing is attached per-request beyond
 * `credentials`, because the browser carries the cookie. */
export function cookieAuth(config: {
  refreshPath?: string;
  credentials?: RequestCredentials;
} = {}): AuthStrategy {
  const { refreshPath = '/api/auth/refresh', credentials = 'include' } = config;
  return {
    decorate(request) {
      return { ...request, credentials, headers: withContentType(request) };
    },
    async refresh({ baseUrl, fetcher }) {
      try {
        const res = await fetcher(`${baseUrl}${refreshPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials,
          body: JSON.stringify({}),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Cross-tab refresh coordination for `bearerAuth` (opt-in, off by default).
 *
 * Why bearerAuth only: this only matters when the access token lives in
 * memory in the tab. `cookieAuth` and `csrfAuth` rely on the browser's
 * session cookie, which the browser already shares across tabs — there is
 * nothing to broadcast. `bearerAuth` is the one strategy where each tab
 * holds its own copy of the token (via `getAccessToken`), so it is the one
 * strategy where sibling tabs can independently race the refresh endpoint.
 *
 * This is a NICETY, NOT A SECURITY CONTROL. The authoritative protection
 * against the benign refresh-rotation race is the server-side grace window
 * that tolerates the old token briefly after rotation. What follows reduces
 * how often the race happens; it does not (and — over a channel with no
 * built-in election, per `postMessage`, no acks — cannot) eliminate it. It
 * is same-origin only (the browser enforces this) and never carries the
 * refresh token — only the short-lived access token this package already
 * has via `getAccessToken`/`onRefreshed`.
 *
 * The protocol, briefly (see `refresh` below for the implementation):
 *   1. A tab about to call the refresh endpoint first broadcasts
 *      `{ type: 'refresh-start', id }`, THEN makes the call. Siblings that
 *      see a start with no matching `refresh-done` yet treat that id as the
 *      leader and await its outcome instead of starting their own refresh —
 *      this is the actual dedup; the old implementation only broadcast the
 *      result, after every tab had already fired its own request.
 *   2. The leader broadcasts `{ type: 'refresh-done', id, success, token? }`
 *      when its call settles (success OR failure). Followers resolve with
 *      that outcome; a failed leader is reported as a failure, never
 *      silently treated as success.
 *   3. A follower does not wait forever: `leaderTimeoutMs` (default 4000)
 *      bounds the wait, so a leader tab that crashes, closes, or hangs mid-
 *      refresh does not hang its siblings — they give up on it and refresh
 *      themselves once the timeout elapses.
 *   4. Two tabs CAN still both claim leadership — if their 401s are close
 *      enough together that neither has received the other's `refresh-start`
 *      before broadcasting its own, both proceed with their own refresh call.
 *      BroadcastChannel has no election primitive, so this residual race is
 *      not eliminated; both calls are safe to make (neither hangs, neither
 *      corrupts state) and the server-side grace window is what makes a
 *      resulting rotation race benign. This is "at most one refresh in the
 *      common (staggered) case, correct — no hang, no silent failure — in
 *      all cases," not a leader-election guarantee.
 */
export interface CrossTabRefreshOptions {
  /** BroadcastChannel name. Give each app its own so two apps on the same
   * origin don't cross-talk on a shared channel namespace. */
  channelName: string;
  /** Called when a sibling tab broadcasts a freshly refreshed access token,
   * so this tab can adopt it (e.g. write it into its own token store)
   * without making its own refresh call. Only ever called with the access
   * token — the refresh token is never broadcast. */
  onTokenReceived: (accessToken: string) => void;
  /** How long a follower waits for the tab it believes is refreshing before
   * giving up and refreshing itself. Guards against a leader tab that
   * crashed, closed, or whose refresh call hangs. Default 4000ms. */
  leaderTimeoutMs?: number;
}

/** `bearerAuth`'s return type, extended with a `close()` to dispose of the
 * BroadcastChannel opened for `crossTabRefresh` (no-op if that option was not
 * used). Call it on unmount / hot-reload so channels don't leak. */
export interface BearerAuthStrategy extends AuthStrategy {
  close(): void;
}

const DEFAULT_LEADER_TIMEOUT_MS = 4000;

interface RefreshStartMessage {
  type: 'refresh-start';
  id: string;
}
interface RefreshDoneMessage {
  type: 'refresh-done';
  id: string;
  success: boolean;
  token?: string;
}
type CrossTabMessage = RefreshStartMessage | RefreshDoneMessage;

/** Bearer-token auth: read the access token from a store, add an
 * Authorization header, and refresh by exchanging the refresh token. The token
 * accessors are injected so the package never owns where tokens live. */
export function bearerAuth(config: {
  getAccessToken: () => string | null;
  refreshPath?: string;
  credentials?: RequestCredentials;
  /** Given the refresh Response, persist the new tokens. Return false to signal
   * the refresh should be treated as failed. */
  onRefreshed: (response: Response) => Promise<boolean> | boolean;
  /** Opt-in cross-tab refresh coordination. Off by default; v0.2.0 behaviour
   * is unchanged when omitted. See `CrossTabRefreshOptions` for the caveats. */
  crossTabRefresh?: CrossTabRefreshOptions;
}): BearerAuthStrategy {
  const { getAccessToken, refreshPath = '/api/auth/refresh', credentials = 'include', onRefreshed, crossTabRefresh } =
    config;

  // Degrade silently when BroadcastChannel is unavailable (SSR, old
  // browsers): channel stays null, and `refresh` below skips the whole
  // coordination protocol whenever it is — single-tab behaviour is exactly
  // the un-coordinated path unconditionally.
  const channel =
    crossTabRefresh && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(crossTabRefresh.channelName)
      : null;

  // Local (per-tab) view of coordination state — never shared except via the
  // messages below.
  let myLeaderId: string | null = null; // set while THIS tab is leading a refresh
  let activeLeaderId: string | null = null; // the peer id this tab is currently following, if any
  const leaderWaiters = new Map<string, Array<(result: { success: boolean; token?: string } | null) => void>>();

  function settleLeader(id: string, result: { success: boolean; token?: string } | null) {
    const waiters = leaderWaiters.get(id);
    if (!waiters) return;
    leaderWaiters.delete(id);
    for (const resolve of waiters) resolve(result);
  }

  // Resolves with the leader's outcome, or `null` if `timeoutMs` elapses
  // first (leader crashed / closed / hung) — never hangs forever.
  function followLeader(id: string, timeoutMs: number): Promise<{ success: boolean; token?: string } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = leaderWaiters.get(id);
        if (waiters) {
          const i = waiters.indexOf(settle);
          if (i >= 0) waiters.splice(i, 1);
          if (waiters.length === 0) leaderWaiters.delete(id);
        }
        resolve(null);
      }, timeoutMs);
      function settle(result: { success: boolean; token?: string } | null) {
        clearTimeout(timer);
        resolve(result);
      }
      const waiters = leaderWaiters.get(id) ?? [];
      waiters.push(settle);
      leaderWaiters.set(id, waiters);
    });
  }

  if (channel && crossTabRefresh) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      const msg = data as CrossTabMessage;
      if (msg.type === 'refresh-start') {
        // First start seen with nobody else currently believed to be leading
        // wins locally. If we are ourselves already mid-refresh, we do NOT
        // defer to a later claimant — we already committed to our own call
        // (the "two tabs claim leadership simultaneously" case: both proceed).
        if (myLeaderId === null && activeLeaderId === null) {
          activeLeaderId = msg.id;
        }
        return;
      }
      if (msg.type === 'refresh-done') {
        if (activeLeaderId === msg.id) activeLeaderId = null;
        // Adopt the token unconditionally on success, even if we were not
        // (or no longer) tracking this id as our leader — this is the
        // "adopt a token a sibling already minted" path for a tab that
        // wasn't mid-refresh at all when the broadcast arrived.
        let adopted = false;
        if (msg.success && msg.token) {
          try {
            crossTabRefresh.onTokenReceived(msg.token);
            adopted = true;
          } catch {
            // A follower cannot safely retry its request with the old token.
            // Report refresh failure while still settling it immediately; a
            // host token-store error must not trigger a second refresh call.
          }
        }
        settleLeader(msg.id, adopted ? { success: true, token: msg.token } : { success: false });
      }
    };
  }

  async function doRefresh(baseUrl: string, fetcher: typeof fetch): Promise<{ success: boolean; token?: string }> {
    try {
      const res = await fetcher(`${baseUrl}${refreshPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials,
      });
      if (!res.ok) return { success: false };
      const refreshed = await onRefreshed(res);
      const token = refreshed ? getAccessToken() : null;
      return { success: refreshed, token: token ?? undefined };
    } catch {
      return { success: false };
    }
  }

  return {
    decorate(request) {
      const token = getAccessToken();
      const headers = withContentType(request, token ? { Authorization: `Bearer ${token}` } : {});
      return { ...request, credentials, headers };
    },
    async refresh({ baseUrl, fetcher }) {
      if (!channel || !crossTabRefresh) {
        return (await doRefresh(baseUrl, fetcher)).success;
      }

      // A sibling appears to already be refreshing — await its outcome
      // instead of also calling the endpoint. This is the actual dedup:
      // unlike the plain-token broadcast this replaces, it runs BEFORE this
      // tab makes any network call, not after every tab already has.
      if (myLeaderId === null && activeLeaderId !== null) {
        const leaderId = activeLeaderId;
        const outcome = await followLeader(leaderId, crossTabRefresh.leaderTimeoutMs ?? DEFAULT_LEADER_TIMEOUT_MS);
        if (outcome !== null) {
          return outcome.success;
        }
        // Timed out waiting (leader crashed / closed / hung) — fall through
        // and refresh ourselves rather than hang forever.
      }

      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      myLeaderId = id;
      channel.postMessage({ type: 'refresh-start', id } satisfies RefreshStartMessage);
      try {
        const result = await doRefresh(baseUrl, fetcher);
        channel.postMessage({
          type: 'refresh-done',
          id,
          success: result.success,
          ...(result.token ? { token: result.token } : {}),
        } satisfies RefreshDoneMessage);
        return result.success;
      } finally {
        myLeaderId = null;
        if (activeLeaderId === id) activeLeaderId = null;
      }
    },
    close() {
      channel?.close();
    },
  };
}

/** CSRF double-submit auth: cookie-based session plus an
 * `x-csrf-token` header read from wherever the app keeps it. */
export function csrfAuth(config: {
  getCsrfToken: () => string | null;
  refreshPath?: string;
  credentials?: RequestCredentials;
  headerName?: string;
} = { getCsrfToken: () => null }): AuthStrategy {
  const {
    getCsrfToken,
    refreshPath = '/api/auth/refresh',
    credentials = 'include',
    headerName = 'x-csrf-token',
  } = config;
  return {
    decorate(request) {
      const token = getCsrfToken();
      const headers = withContentType(request, token ? { [headerName]: token } : {});
      return { ...request, credentials, headers };
    },
    async refresh({ baseUrl, fetcher }) {
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        const token = getCsrfToken();
        if (token) headers[headerName] = token;
        const res = await fetcher(`${baseUrl}${refreshPath}`, { method: 'POST', headers, credentials });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
