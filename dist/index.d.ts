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
