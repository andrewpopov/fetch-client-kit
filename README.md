# @andrewpopov/fetch-client-kit

Framework-agnostic browser fetch client: on a `401`, it refreshes auth **once**
and retries — deduplicating concurrent refreshes so N overlapping `401`s trigger
exactly **one** refresh. How auth attaches to a request (session cookie, bearer
token, CSRF header) is the one pluggable seam, an `AuthStrategy`. Zero runtime
dependencies; the browser `fetch` is the only ambient requirement.

## Install

```bash
npm install github:andrewpopov/fetch-client-kit#v0.3.5
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
is self-typed (`FormData`, `Blob`, `ArrayBuffer`, typed arrays,
`URLSearchParams`, `ReadableStream`) — the browser must set that header itself,
e.g. to include the multipart `boundary=`.

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
    // Fired when a sibling tab's refresh (in-flight or already finished)
    // produced a token — adopt it instead of this tab making its own call.
    onTokenReceived: (token) => { accessToken = token; },
    // How long a follower waits for a sibling it believes is already
    // refreshing before giving up and refreshing itself. Guards against a
    // leader tab that crashed, closed, or whose call hangs. Default 4000ms.
    leaderTimeoutMs: 4000,
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

**What the protocol actually does.** A tab about to call the refresh endpoint
broadcasts `refresh-start` *before* making the call. A sibling that sees a
start with no matching completion yet treats that tab as the leader and
**awaits its outcome instead of also calling the endpoint** — this is real
deduplication, not just after-the-fact token sharing. The leader broadcasts
`refresh-done` (success or failure) when its call settles; a follower that
was awaiting it resolves with that same outcome — a **failed** leader is
reported to followers as a failure, never silently treated as success. A
follower does not wait forever: `leaderTimeoutMs` bounds the wait, so a
leader tab that crashes, closes, or hangs mid-refresh does not hang its
siblings — they give up on it and refresh themselves once the timeout
elapses.

If a follower cannot persist the broadcast access token because
`onTokenReceived` throws, the follower settles that shared refresh as failed
immediately. It does not wait for the leader timeout or issue a redundant
refresh with stale local state.

`BroadcastChannel` has no election primitive, so this is **not** a
race-free guarantee: if two tabs' `401`s are close enough together that
neither has yet received the other's `refresh-start`, both will still
broadcast their own and both will call the endpoint — the guarantee is "at
most one refresh in the common (staggered) case, correct — no hang, no
silent failure — in every case," not "exactly one, always."

### The multi-tab refresh-rotation footgun

This package's 401→refresh single-flight dedup is **per tab**, not per
origin. With `bearerAuth` and multiple tabs open against the same session,
two tabs can each independently observe a `401` and race the server's
rotation endpoint — `crossTabRefresh` closes most of that window (see above)
but, per the guarantee stated above, cannot close all of it. If your auth
backend runs strict (zero-tolerance) rotation-reuse detection, the loser of
that residual race presents a token the server just rotated out and gets
classified as **reuse** — the server revokes the whole session family, and
every tab (winner included) gets logged out for what was an entirely benign
race, not an attack.

There are two independent defenses; use both for a multi-tab `bearerAuth`
deployment:

1. **Client-side: enable `crossTabRefresh` (this option).** It is a nicety,
   not a security control by itself — a sibling that sees a refresh already
   in flight awaits it instead of starting its own, which removes the race
   entirely for tabs whose `401`s are staggered by even a broadcast
   round-trip. It cannot prevent two tabs claiming leadership at the exact
   same instant (no election primitive over `BroadcastChannel`), a tab being
   slow to receive the broadcast, or `BroadcastChannel` being unavailable.
2. **Server-side: a rotation grace window.** The authoritative protection is
   your auth backend tolerating the just-rotated-out token for a short
   window instead of immediately treating a replay as reuse.
   [`@andrewpopov/auth-kit`](https://github.com/andrewpopov/auth-kit)'s
   `rotateRefreshToken` ships this **on by default as of 0.5.0**
   (`DEFAULT_ROTATION_GRACE_MS`, 30s) specifically to close this footgun —
   PKG-25 — for consumers who don't (or can't) coordinate refreshes
   client-side. If your backend uses a different rotation implementation,
   confirm it has an equivalent grace window; a strict-by-default rotation
   scheme combined with multi-tab `bearerAuth` and `crossTabRefresh` left off
   is exactly the combination that triggers this.

**Recommendation:** for any multi-tab `bearerAuth` deployment, turn on
`crossTabRefresh` here (it removes most races before they reach the server)
and confirm your backend's rotation grace window is enabled (it absorbs
whatever race remains — including the residual simultaneous-claim race
`crossTabRefresh` cannot itself close). Neither alone is sufficient — the
client control reduces frequency, the server control makes the residual race
benign instead of a family-wide logout.

- `BroadcastChannel` is same-origin only — no cross-origin leakage risk.
- Only the short-lived **access token** is ever broadcast, never a refresh
  token; this package never has a refresh token to begin with (`bearerAuth`
  only handles the access token, via `getAccessToken`/`onRefreshed`). The
  `refresh-start`/`refresh-done` coordination messages carry no token except
  the completed access token on a successful `refresh-done`.
- Degrades silently when `BroadcastChannel` is unavailable (SSR, older
  browsers) — it never throws, the client just works exactly like
  `crossTabRefresh` was never configured (no coordination, no adoption).

## API

`createFetchClient(options)` returns `{ request, upload, refresh }`.

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | prefixed to every request path |
| `auth` | required | an `AuthStrategy` |
| `fetcher` | global `fetch` | injected for tests |
| `authPathPrefixes` | `['/api/auth/']` | paths (matched by prefix) whose `401`s never trigger a refresh — the auth endpoints themselves |
| `parseError` | reads a JSON `{ error }` body, falls back to status text | turns a non-ok `Response` into the `Error` that `request` rejects with |
| `uploadTransport` | `xhrUploadTransport()`, or `fetchUploadTransport(fetcher)` without `XMLHttpRequest` | how `upload` sends bytes; see [Uploads](#uploads) |
| `onAuthFailure` | — | called once when a refresh fails on a retriable `401`, e.g. to clear auth state and redirect to login — once per failed refresh attempt, even when many concurrent `401`s share that one attempt; it is an observer hook, so an exception from it cannot replace the request's own error |

- `request<T>(path, init?)` — resolves with the parsed JSON body. `204` and
  empty bodies resolve to `undefined`; non-ok responses reject with
  `parseError`'s Error (the default attaches `.status`, and never throws in
  its place — a non-object JSON body like `null` or `[]` falls back to the
  status text / `Request failed (<status>)` instead of crashing on a missing
  `.error`/`.message`).
- `upload<T>(options)` — send a body through the same `401` → refresh → resend
  loop, with progress and cancellation; resolves the parsed JSON like `request`.
  See [Uploads](#uploads).
- `refresh()` — force a refresh (e.g. on app focus); shares the same
  single-flight promise as the `401` path.

## Uploads

```ts
const controller = new AbortController();
const photo = await api.upload<Photo>({
  path: '/animals/1/photo',
  method: 'PUT',                       // 'POST' | 'PUT' | 'PATCH'
  body: file,                          // Blob | FormData | ArrayBuffer | view | URLSearchParams | string
  headers: { 'Idempotency-Key': key },
  onProgress: ({ loaded, total }) => {}, // total is undefined when unknown
  signal: controller.signal,
  beforeRetry: () => {},               // throw to stop (e.g. the session changed)
});
```

`upload` shares `request`'s loop and its single-flight refresh, so an upload
`401` and a `request` `401` in flight together trigger one refresh. Details:

- **Re-decorated per attempt.** The strategy's `decorate` runs again for the
  resend from your original input, so the resend carries the refreshed token.
  The same body object is sent both times. Progress restarts from zero on the
  resend.
- **Cancellation.** Every cancellation (a pre-aborted signal, an abort mid-send,
  an abort while the refresh is pending) rejects with an `AbortError`
  (`isAbortError(e)`). A custom `signal.reason` is kept as `error.cause`. A
  cancelled upload never starts a refresh it doesn't need, never resends and
  never fires `onAuthFailure`; the shared refresh keeps running for other callers.
- **`beforeRetry`.** Called after a retriable `401`, before the refresh, and
  again after it settles, before the resend or `onAuthFailure`. If it throws,
  `upload` rejects with that error unchanged and neither happens for it.
- **Errors.** A non-2xx response rejects with `parseError`'s Error; a network
  failure with a `TypeError`; invalid JSON in a 2xx with a `SyntaxError`.
- **Transport seam.** `uploadTransport` receives `{ url, method, headers,
  credentials, body, onProgress, signal }` and resolves a `Response` for any
  status. `xhrUploadTransport()` (the default, resolved per call) reports
  progress and skips headers browsers forbid, such as `Content-Length`.
  `fetchUploadTransport()` has no progress. XHR cannot omit credentials on a
  same-origin request, so with the default transport a strategy that asks for
  `credentials: 'omit'` goes through fetch, without progress.
- **Content-Type.** `Blob`, `ArrayBuffer`, typed arrays, `URLSearchParams`,
  `ReadableStream` and `FormData` bodies get no default `application/json` (the
  platform types them); this applies to `request` too. String bodies still
  default to JSON.

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

## Project policies

See [Contributing](./CONTRIBUTING.md), [Support](./SUPPORT.md), and the
[Security Policy](./SECURITY.md). This package is licensed under [MIT](./LICENSE).
