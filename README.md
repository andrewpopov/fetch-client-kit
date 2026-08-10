# @andrewpopov/fetch-client-kit

Framework-agnostic browser fetch client: on a `401`, it refreshes auth **once**
and retries — deduplicating concurrent refreshes so N overlapping `401`s trigger
exactly **one** refresh. How auth attaches to a request (session cookie, bearer
token, CSRF header) is the one pluggable seam, an `AuthStrategy`. Zero runtime
dependencies; the browser `fetch` is the only ambient requirement.

## Install

```bash
npm install github:andrewpopov/fetch-client-kit#v0.3.3
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

`createFetchClient(options)` returns `{ request, refresh }`.

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | prefixed to every request path |
| `auth` | required | an `AuthStrategy` |
| `fetcher` | global `fetch` | injected for tests |
| `authPathPrefixes` | `['/api/auth/']` | paths (matched by prefix) whose `401`s never trigger a refresh — the auth endpoints themselves |
| `parseError` | reads a JSON `{ error }` body, falls back to status text | turns a non-ok `Response` into the `Error` that `request` rejects with |
| `onAuthFailure` | — | called once when a refresh fails on a retriable `401`, e.g. to clear auth state and redirect to login — once per failed refresh attempt, even when many concurrent `401`s share that one attempt; it is an observer hook, so an exception from it cannot replace the request's own error |

- `request<T>(path, init?)` — resolves with the parsed JSON body. `204` and
  empty bodies resolve to `undefined`; non-ok responses reject with
  `parseError`'s Error (the default attaches `.status`, and never throws in
  its place — a non-object JSON body like `null` or `[]` falls back to the
  status text / `Request failed (<status>)` instead of crashing on a missing
  `.error`/`.message`).
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

## Project policies

See [Contributing](./CONTRIBUTING.md), [Support](./SUPPORT.md), and the
[Security Policy](./SECURITY.md). This package is licensed under [MIT](./LICENSE).
