# @andrewpopov/fetch-client-kit

Framework-agnostic browser fetch client: on a `401`, it refreshes auth **once**
and retries — deduplicating concurrent refreshes so N overlapping `401`s trigger
exactly **one** refresh. How auth attaches to a request (session cookie, bearer
token, CSRF header) is the one pluggable seam, an `AuthStrategy`. Zero runtime
dependencies; the browser `fetch` is the only ambient requirement.

## Install

```bash
npm install github:andrewpopov/fetch-client-kit#v0.2.0
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
| `bearerAuth({ getAccessToken, onRefreshed })` | `Authorization: Bearer …` | a token kept in your own store |
| `csrfAuth({ getCsrfToken })` | `x-csrf-token` header | CSRF double-submit |

Every built-in strategy accepts `refreshPath` (default `'/api/auth/refresh'`)
and `credentials`; `csrfAuth` also accepts `headerName`. Each adds
`Content-Type: application/json` unless the caller already set one or the body
is a `FormData` — the browser must set that header itself to include the
multipart `boundary=`.

The token accessors are injected, so the package never owns where tokens live.
Write your own `AuthStrategy` for anything else — it is a two-method interface
(`decorate` a request, `refresh`).

## API

`createFetchClient(options)` returns `{ request, refresh }`.

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | prefixed to every request path |
| `auth` | required | an `AuthStrategy` |
| `fetcher` | global `fetch` | injected for tests |
| `authPathPrefixes` | `['/api/auth/']` | paths (matched by prefix) whose `401`s never trigger a refresh — the auth endpoints themselves |
| `parseError` | reads a JSON `{ error }` body, falls back to status text | turns a non-ok `Response` into the `Error` that `request` rejects with |
| `onAuthFailure` | — | called once when a refresh fails on a retriable `401`, e.g. to clear auth state and redirect to login; the request still rejects with its own error |

- `request<T>(path, init?)` — resolves with the parsed JSON body. `204` and
  empty bodies resolve to `undefined`; non-ok responses reject with
  `parseError`'s Error (the default attaches `.status`).
- `refresh()` — force a refresh (e.g. on app focus); shares the same
  single-flight promise as the `401` path.

## The single-flight guarantee

The first `401` starts a refresh; every concurrent `401` awaits the **same**
promise instead of firing its own. Auth-endpoint `401`s never trigger a refresh.
A failed refresh does not retry — the original error surfaces.
