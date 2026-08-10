"use strict";
// @andrewpopov/fetch-client-kit
//
// One implementation of a transport apps commonly hand-roll: a base-URL fetch
// wrapper that, on a 401, refreshes once and retries — deduplicating concurrent
// refreshes so N overlapping 401s trigger exactly ONE refresh. Consumers differ
// only in how auth attaches to a request (cookie, bearer, csrf header); that is
// the one pluggable seam, an AuthStrategy.
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFetchClient = createFetchClient;
exports.cookieAuth = cookieAuth;
exports.bearerAuth = bearerAuth;
exports.csrfAuth = csrfAuth;
async function defaultParseError(response) {
    // The body is untrusted server output: valid JSON can still be `null`, an
    // array, or a string (e.g. `"null"`, `"[]"`, `'"nope"'` are all parseable),
    // none of which has `.error`/`.message` to read. Narrow to a plain object
    // before touching either property, or a literal JSON `null` body throws a
    // TypeError here that replaces the status-bearing Error this is supposed
    // to construct — the caller would see an unrelated crash instead of a
    // rejection carrying `.status`.
    const parsed = await response.json().catch(() => undefined);
    const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const message = (typeof body.error === 'string' && body.error) ||
        (typeof body.message === 'string' && body.message) ||
        response.statusText ||
        `Request failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    return err;
}
// A FormData body must NOT get an explicit Content-Type: the browser sets it,
// including the multipart `boundary=` the server needs to parse the upload.
// Forcing application/json there silently corrupts every file upload. Applies to
// every strategy, so it lives here.
function withContentType(request, extra = {}) {
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
    const normalized = {};
    headers.forEach((value, name) => {
        normalized[name] = value;
    });
    return normalized;
}
function createFetchClient(options) {
    const { baseUrl, auth, 
    // Late-bound on purpose. `fetcher = fetch` would capture the CURRENT global
    // fetch at construction time — and every consumer builds its client at module
    // scope, before any test stubs `globalThis.fetch`. The client would then
    // bypass the stub and hit the real network, silently. Re-resolving the global
    // per call keeps the default late-bound so a later stub is honoured.
    fetcher = (input, init) => fetch(input, init), authPathPrefixes = ['/api/auth/'], parseError = defaultParseError, onAuthFailure, } = options;
    // Single-flight refresh: the FIRST 401 to arrive starts the refresh; every
    // other concurrent 401 awaits the SAME promise instead of firing its own. This
    // is the property all three consumers hand-rolled (and where they could each
    // drift into a bug). Cleared in `finally` so the next 401 after settle starts
    // fresh.
    let inFlightRefresh = null;
    // `onAuthFailure` must fire once per *refresh attempt*, not once per waiter.
    // N concurrent 401s share the one `inFlightRefresh` promise above, but each
    // waiter's own `request()` continuation used to run its own `onAuthFailure()`
    // call after that shared promise settled — 8 concurrent 401s meant 8 calls to
    // a hook whose job is typically to wipe local state and redirect to login.
    // Reset alongside `inFlightRefresh` so the next attempt notifies again.
    let authFailureNotified = false;
    function refresh() {
        if (!inFlightRefresh) {
            authFailureNotified = false;
            inFlightRefresh = auth
                .refresh({ baseUrl, fetcher })
                .catch(() => false)
                .finally(() => {
                inFlightRefresh = null;
            });
        }
        return inFlightRefresh;
    }
    function shouldRetry(path, status) {
        if (status !== 401)
            return false;
        // Never try to refresh in response to the refresh/login endpoint 401-ing.
        return !authPathPrefixes.some((prefix) => path.startsWith(prefix));
    }
    async function send(path, options) {
        return fetcher(`${baseUrl}${path}`, auth.decorate(options));
    }
    async function request(path, options = {}) {
        let response = await send(path, options);
        if (shouldRetry(path, response.status)) {
            const refreshed = await refresh();
            if (refreshed) {
                response = await send(path, options);
            }
            else if (onAuthFailure && !authFailureNotified) {
                // Guard so concurrent waiters on the same failed refresh notify once
                // (see `authFailureNotified` above), not once per waiter.
                authFailureNotified = true;
                // This is an observer hook. A redirect or state-cleanup error must not
                // replace the request error the caller needs to handle.
                try {
                    onAuthFailure();
                }
                catch {
                    // Preserve the original failed response below.
                }
            }
        }
        if (!response.ok) {
            throw await parseError(response);
        }
        // 204 and empty bodies parse to undefined rather than throwing.
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined);
    }
    return { request, refresh };
}
// --- Built-in auth strategies -------------------------------------------------
/** Cookie/session auth: send credentials, add JSON headers, and
 * refresh by POSTing to the refresh path. Nothing is attached per-request beyond
 * `credentials`, because the browser carries the cookie. */
function cookieAuth(config = {}) {
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
            }
            catch {
                return false;
            }
        },
    };
}
const DEFAULT_LEADER_TIMEOUT_MS = 4000;
/** Bearer-token auth: read the access token from a store, add an
 * Authorization header, and refresh by exchanging the refresh token. The token
 * accessors are injected so the package never owns where tokens live. */
function bearerAuth(config) {
    const { getAccessToken, refreshPath = '/api/auth/refresh', credentials = 'include', onRefreshed, crossTabRefresh } = config;
    // Degrade silently when BroadcastChannel is unavailable (SSR, old
    // browsers): channel stays null, and `refresh` below skips the whole
    // coordination protocol whenever it is — single-tab behaviour is exactly
    // the un-coordinated path unconditionally.
    const channel = crossTabRefresh && typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(crossTabRefresh.channelName)
        : null;
    // Local (per-tab) view of coordination state — never shared except via the
    // messages below.
    let myLeaderId = null; // set while THIS tab is leading a refresh
    let activeLeaderId = null; // the peer id this tab is currently following, if any
    const leaderWaiters = new Map();
    function settleLeader(id, result) {
        const waiters = leaderWaiters.get(id);
        if (!waiters)
            return;
        leaderWaiters.delete(id);
        for (const resolve of waiters)
            resolve(result);
    }
    // Resolves with the leader's outcome, or `null` if `timeoutMs` elapses
    // first (leader crashed / closed / hung) — never hangs forever.
    function followLeader(id, timeoutMs) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const waiters = leaderWaiters.get(id);
                if (waiters) {
                    const i = waiters.indexOf(settle);
                    if (i >= 0)
                        waiters.splice(i, 1);
                    if (waiters.length === 0)
                        leaderWaiters.delete(id);
                }
                resolve(null);
            }, timeoutMs);
            function settle(result) {
                clearTimeout(timer);
                resolve(result);
            }
            const waiters = leaderWaiters.get(id) ?? [];
            waiters.push(settle);
            leaderWaiters.set(id, waiters);
        });
    }
    if (channel && crossTabRefresh) {
        channel.onmessage = (event) => {
            const data = event.data;
            if (!data || typeof data !== 'object' || !('type' in data))
                return;
            const msg = data;
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
                if (activeLeaderId === msg.id)
                    activeLeaderId = null;
                // Adopt the token unconditionally on success, even if we were not
                // (or no longer) tracking this id as our leader — this is the
                // "adopt a token a sibling already minted" path for a tab that
                // wasn't mid-refresh at all when the broadcast arrived.
                if (msg.success && msg.token)
                    crossTabRefresh.onTokenReceived(msg.token);
                settleLeader(msg.id, msg.success ? { success: true, token: msg.token } : { success: false });
            }
        };
    }
    async function doRefresh(baseUrl, fetcher) {
        try {
            const res = await fetcher(`${baseUrl}${refreshPath}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials,
            });
            if (!res.ok)
                return { success: false };
            const refreshed = await onRefreshed(res);
            const token = refreshed ? getAccessToken() : null;
            return { success: refreshed, token: token ?? undefined };
        }
        catch {
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
            channel.postMessage({ type: 'refresh-start', id });
            try {
                const result = await doRefresh(baseUrl, fetcher);
                channel.postMessage({
                    type: 'refresh-done',
                    id,
                    success: result.success,
                    ...(result.token ? { token: result.token } : {}),
                });
                return result.success;
            }
            finally {
                myLeaderId = null;
                if (activeLeaderId === id)
                    activeLeaderId = null;
            }
        },
        close() {
            channel?.close();
        },
    };
}
/** CSRF double-submit auth: cookie-based session plus an
 * `x-csrf-token` header read from wherever the app keeps it. */
function csrfAuth(config = { getCsrfToken: () => null }) {
    const { getCsrfToken, refreshPath = '/api/auth/refresh', credentials = 'include', headerName = 'x-csrf-token', } = config;
    return {
        decorate(request) {
            const token = getCsrfToken();
            const headers = withContentType(request, token ? { [headerName]: token } : {});
            return { ...request, credentials, headers };
        },
        async refresh({ baseUrl, fetcher }) {
            try {
                const headers = { 'Content-Type': 'application/json' };
                const token = getCsrfToken();
                if (token)
                    headers[headerName] = token;
                const res = await fetcher(`${baseUrl}${refreshPath}`, { method: 'POST', headers, credentials });
                return res.ok;
            }
            catch {
                return false;
            }
        },
    };
}
