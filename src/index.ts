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
}

export interface FetchClient {
  request<T>(path: string, options?: RequestInit): Promise<T>;
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
// Forcing application/json there silently corrupts every file upload. Applies to
// every strategy, so it lives here.
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
  const isFormData = typeof FormData !== 'undefined' && request.body instanceof FormData;
  if (!isFormData && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const normalized: Record<string, string> = {};
  headers.forEach((value, name) => {
    normalized[name] = value;
  });
  return normalized;
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

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    let response = await send(path, options);

    if (shouldRetry(path, response.status)) {
      const refreshed = await refresh();
      if (refreshed) {
        response = await send(path, options);
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

    if (!response.ok) {
      throw await parseError(response);
    }

    // 204 and empty bodies parse to undefined rather than throwing.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return { request, refresh };
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
        if (msg.success && msg.token) crossTabRefresh.onTokenReceived(msg.token);
        settleLeader(msg.id, msg.success ? { success: true, token: msg.token } : { success: false });
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
