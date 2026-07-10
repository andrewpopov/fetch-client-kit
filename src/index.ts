// @andrewpopov/fetch-client-kit
//
// One implementation of the transport that smarthome, savoro, and towerpower each
// hand-rolled: a base-URL fetch wrapper that, on a 401, refreshes once and retries
// — deduplicating concurrent refreshes so N overlapping 401s trigger exactly ONE
// refresh. The three apps differed only in how auth attaches to a request (cookie,
// bearer, csrf header); that is the one pluggable seam, an AuthStrategy.

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

export function createFetchClient(options: FetchClientOptions): FetchClient {
  const {
    baseUrl,
    auth,
    fetcher = fetch,
    authPathPrefixes = ['/api/auth/'],
    parseError = defaultParseError,
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

/** Cookie/session auth (smarthome): send credentials, add JSON headers, and
 * refresh by POSTing to the refresh path. Nothing is attached per-request beyond
 * `credentials`, because the browser carries the cookie. */
export function cookieAuth(config: {
  refreshPath?: string;
  credentials?: RequestCredentials;
} = {}): AuthStrategy {
  const { refreshPath = '/api/auth/refresh', credentials = 'include' } = config;
  return {
    decorate(request) {
      return {
        ...request,
        credentials,
        headers: { 'Content-Type': 'application/json', ...request.headers },
      };
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

/** Bearer-token auth (savoro): read the access token from a store, add an
 * Authorization header, and refresh by exchanging the refresh token. The token
 * accessors are injected so the package never owns where tokens live. */
export function bearerAuth(config: {
  getAccessToken: () => string | null;
  refreshPath?: string;
  credentials?: RequestCredentials;
  /** Given the refresh Response, persist the new tokens. Return false to signal
   * the refresh should be treated as failed. */
  onRefreshed: (response: Response) => Promise<boolean> | boolean;
}): AuthStrategy {
  const { getAccessToken, refreshPath = '/api/auth/refresh', credentials = 'include', onRefreshed } = config;
  return {
    decorate(request) {
      const token = getAccessToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(request.headers as Record<string, string> | undefined),
      };
      if (token) headers.Authorization = `Bearer ${token}`;
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
        return await onRefreshed(res);
      } catch {
        return false;
      }
    },
  };
}

/** CSRF double-submit auth (towerpower): cookie-based session plus an
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(request.headers as Record<string, string> | undefined),
      };
      const token = getCsrfToken();
      if (token) headers[headerName] = token;
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
