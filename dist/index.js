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
    const body = (await response
        .json()
        .catch(() => ({ error: response.statusText })));
    const err = new Error(body.error || body.message || `Request failed (${response.status})`);
    err.status = response.status;
    return err;
}
// A FormData body must NOT get an explicit Content-Type: the browser sets it,
// including the multipart `boundary=` the server needs to parse the upload.
// Forcing application/json there silently corrupts every file upload. Applies to
// every strategy, so it lives here.
function withContentType(request, extra = {}) {
    const headers = {
        ...request.headers,
        ...extra,
    };
    const isFormData = typeof FormData !== 'undefined' && request.body instanceof FormData;
    const alreadySet = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
    if (!isFormData && !alreadySet) {
        headers['Content-Type'] = 'application/json';
    }
    return headers;
}
function createFetchClient(options) {
    const { baseUrl, auth, fetcher = fetch, authPathPrefixes = ['/api/auth/'], parseError = defaultParseError, onAuthFailure, } = options;
    // Single-flight refresh: the FIRST 401 to arrive starts the refresh; every
    // other concurrent 401 awaits the SAME promise instead of firing its own. This
    // is the property all three consumers hand-rolled (and where they could each
    // drift into a bug). Cleared in `finally` so the next 401 after settle starts
    // fresh.
    let inFlightRefresh = null;
    function refresh() {
        if (!inFlightRefresh) {
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
            else if (onAuthFailure) {
                onAuthFailure();
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
/** Bearer-token auth: read the access token from a store, add an
 * Authorization header, and refresh by exchanging the refresh token. The token
 * accessors are injected so the package never owns where tokens live. */
function bearerAuth(config) {
    const { getAccessToken, refreshPath = '/api/auth/refresh', credentials = 'include', onRefreshed } = config;
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
                if (!res.ok)
                    return false;
                return await onRefreshed(res);
            }
            catch {
                return false;
            }
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
