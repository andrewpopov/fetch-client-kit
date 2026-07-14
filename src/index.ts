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
  const body = (await response
    .json()
    .catch(() => ({ error: response.statusText }))) as { error?: string; message?: string };
  const err = new Error(body.error || body.message || `Request failed (${response.status})`);
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

  function refresh(): Promise<boolean> {
    if (!inFlightRefresh) {
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
      } else if (onAuthFailure) {
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
 * that tolerates the old token briefly after rotation. BroadcastChannel just
 * saves redundant refresh calls by letting sibling tabs adopt a token a
 * sibling already minted. It is same-origin only (the browser enforces
 * this) and never carries the refresh token — only the short-lived access
 * token this package already has via `getAccessToken`/`onRefreshed`.
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
}

/** `bearerAuth`'s return type, extended with a `close()` to dispose of the
 * BroadcastChannel opened for `crossTabRefresh` (no-op if that option was not
 * used). Call it on unmount / hot-reload so channels don't leak. */
export interface BearerAuthStrategy extends AuthStrategy {
  close(): void;
}

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
  // browsers): channel stays null, and every use below is optional-chained.
  const channel =
    crossTabRefresh && typeof BroadcastChannel !== 'undefined'
      ? new BroadcastChannel(crossTabRefresh.channelName)
      : null;

  if (channel && crossTabRefresh) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (typeof event.data === 'string' && event.data.length > 0) {
        crossTabRefresh.onTokenReceived(event.data);
      }
    };
  }

  return {
    decorate(request) {
      const token = getAccessToken();
      const headers = withContentType(request, token ? { Authorization: `Bearer ${token}` } : {});
      return { ...request, credentials, headers };
    },
    async refresh({ baseUrl, fetcher }) {
      try {
        const res = await fetcher(`${baseUrl}${refreshPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials,
        });
        if (!res.ok) return false;
        const refreshed = await onRefreshed(res);
        // Broadcast the newly-stored access token (never the refresh token —
        // this package never has one) so sibling tabs on the same channel can
        // adopt it instead of each firing their own refresh call.
        if (refreshed && channel) {
          const token = getAccessToken();
          if (token) channel.postMessage(token);
        }
        return refreshed;
      } catch {
        return false;
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
