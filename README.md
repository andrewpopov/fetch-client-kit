# @andrewpopov/fetch-client-kit

Framework-agnostic browser fetch client: on a `401`, it refreshes auth **once**
and retries — deduplicating concurrent refreshes so N overlapping `401`s trigger
exactly **one** refresh. How auth attaches to a request (session cookie, bearer
token, CSRF header) is the one pluggable seam, an `AuthStrategy`. Zero runtime
dependencies; the browser `fetch` is the only ambient requirement.

## Install

```bash
npm install github:andrewpopov/fetch-client-kit#v0.3.2
```

## Usage

```ts
import { createFetchClient, cookieAuth } from '@andrewpopov/fetch-client-kit';

const api = createFetchClient({ baseUrl: '/api', auth: cookieAuth() });
const user = await api.request<User>('/me');
```

## Auth strategies

| Strategy | Attaches | For |
|---|---|---|
| `cookieAuth()` | `credentials: 'include'` | session cookies |
| `bearerAuth({ getAccessToken, onRefreshed, crossTabRefresh? })` | `Authorization: Bearer …` | a token kept in your own store |
| `csrfAuth({ getCsrfToken })` | `x-csrf-token` header | CSRF double-submit |

Every built-in strategy accepts `refreshPath` (default `'/api/auth/refresh'`)
and `credentials`; `csrfAuth` also accepts `headerName`. Each adds
`Content-Type: application/json` unless the caller already set one or the body
is a `FormData` — the browser must set that header itself to include the
multipart `boundary=`.

Caller headers may use any standard `HeadersInit` form: a plain object, tuple
array, or `Headers` instance. Their values are retained when a strategy adds
its own auth and content-type headers.

The token accessors are injected, so the package never owns where tokens live.
Write your own `AuthStrategy` for anything else — it is a two-method interface
(`decorate` a request, `refresh`).

## Cross-tab refresh coordination (`bearerAuth` only)

`bearerAuth` accepts an opt-in `crossTabRefresh` option. It is **off by
default** — omit it and v0.2.0 behaviour is unchanged byte-for-byte.

```ts
import { createFetchClient, bearerAuth } from '@andrewpopov/fetch-client-kit';

let accessToken: string | null = null; // in-memory only — never localStorage

const auth = bearerAuth({
  getAccessToken: () => accessToken,
  onRefreshed: async (res) => {
    const body = await res.json();
    accessToken = body.accessToken;
    return true;
  },
  crossTabRefresh: {
    // Give each app its own name so two apps on the same origin don't cross-talk.
    channelName: 'my-app-auth-refresh',
    // Fired when a sibling tab already refreshed — adopt its token instead
    // of this tab making its own refresh call.
    onTokenReceived: (token) => { accessToken = token; },
  },
});

const api = createFetchClient({ baseUrl: '/api', auth });
// ...
auth.close(); // dispose the BroadcastChannel (tests, hot-reload)
```

This only matters for `bearerAuth`: the access token lives in memory in the
tab, so sibling tabs each hold their own copy and can independently race the
refresh endpoint. `cookieAuth` and `csrfAuth` rely on the browser's session
cookie, which is already shared across tabs — there's nothing to broadcast.

**This is a nicety, not a security control.** The authoritative protection
against the benign refresh-rotation race is your server's rotation grace
window (tolerating the just-rotated-out token for a short overlap).
BroadcastChannel only saves redundant refresh round-trips by letting sibling
tabs adopt a token a sibling already minted.

- `BroadcastChannel` is same-origin only — no cross-origin leakage risk.
- Only the short-lived **access token** is ever broadcast, never a refresh
  token; this package never has a refresh token to begin with (`bearerAuth`
  only handles the access token, via `getAccessToken`/`onRefreshed`).
- Degrades silently when `BroadcastChannel` is unavailable (SSR, older
  browsers) — it never throws, the client just works without cross-tab
  adoption.

## API

`createFetchClient(options)` returns `{ request, refresh }`.

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | prefixed to every request path |
| `auth` | required | an `AuthStrategy` |
| `fetcher` | global `fetch` | injected for tests |
| `authPathPrefixes` | `['/api/auth/']` | paths (matched by prefix) whose `401`s never trigger a refresh — the auth endpoints themselves |
| `parseError` | reads a JSON `{ error }` body, falls back to status text | turns a non-ok `Response` into the `Error` that `request` rejects with |
| `onAuthFailure` | — | called once when a refresh fails on a retriable `401`, e.g. to clear auth state and redirect to login; it is an observer hook, so an exception from it cannot replace the request's own error |

- `request<T>(path, init?)` — resolves with the parsed JSON body. `204` and
  empty bodies resolve to `undefined`; non-ok responses reject with
  `parseError`'s Error (the default attaches `.status`).
- `refresh()` — force a refresh (e.g. on app focus); shares the same
  single-flight promise as the `401` path.

## The single-flight guarantee

The first `401` starts a refresh; every concurrent `401` awaits the **same**
promise instead of firing its own. Auth-endpoint `401`s never trigger a refresh.
A failed refresh does not retry — the original error surfaces.

## Verify locally

GitHub Actions are optional for this repository. Before opening a change or
cutting a tag, run the local release gate:

```bash
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```
