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
export declare function createFetchClient(options: FetchClientOptions): FetchClient;
/** Cookie/session auth: send credentials, add JSON headers, and
 * refresh by POSTing to the refresh path. Nothing is attached per-request beyond
 * `credentials`, because the browser carries the cookie. */
export declare function cookieAuth(config?: {
    refreshPath?: string;
    credentials?: RequestCredentials;
}): AuthStrategy;
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
export declare function bearerAuth(config: {
    getAccessToken: () => string | null;
    refreshPath?: string;
    credentials?: RequestCredentials;
    /** Given the refresh Response, persist the new tokens. Return false to signal
     * the refresh should be treated as failed. */
    onRefreshed: (response: Response) => Promise<boolean> | boolean;
    /** Opt-in cross-tab refresh coordination. Off by default; v0.2.0 behaviour
     * is unchanged when omitted. See `CrossTabRefreshOptions` for the caveats. */
    crossTabRefresh?: CrossTabRefreshOptions;
}): BearerAuthStrategy;
/** CSRF double-submit auth: cookie-based session plus an
 * `x-csrf-token` header read from wherever the app keeps it. */
export declare function csrfAuth(config?: {
    getCsrfToken: () => string | null;
    refreshPath?: string;
    credentials?: RequestCredentials;
    headerName?: string;
}): AuthStrategy;
