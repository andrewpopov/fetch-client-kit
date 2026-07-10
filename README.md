# @andrewpopov/fetch-client-kit

## Install

```bash
npm install github:andrewpopov/fetch-client-kit#v0.1.0
```

One browser fetch client that, on a `401`, refreshes **once** and retries —
deduplicating concurrent refreshes so N overlapping `401`s trigger exactly **one**
refresh. smarthome, savoro, and towerpower each hand-rolled this; they differed
only in how auth attaches to a request. That is the one pluggable seam.

```ts
import { createFetchClient, cookieAuth } from '@andrewpopov/fetch-client-kit';

const api = createFetchClient({ baseUrl: '/api', auth: cookieAuth() });
const user = await api.request<User>('/me');
```

## Auth strategies

| Strategy | Attaches | For |
|---|---|---|
| `cookieAuth()` | `credentials: 'include'` | session cookies (smarthome) |
| `bearerAuth({ getAccessToken, onRefreshed })` | `Authorization: Bearer …` | token in a store (savoro) |
| `csrfAuth({ getCsrfToken })` | `x-csrf-token` header | CSRF double-submit (towerpower) |

The token accessors are injected, so the package never owns where tokens live.
Write your own `AuthStrategy` for anything else — it is a two-method interface
(`decorate` a request, `refresh`).

## The single-flight guarantee

The first `401` starts a refresh; every concurrent `401` awaits the **same**
promise instead of firing its own. Auth-endpoint `401`s never trigger a refresh.
A failed refresh does not retry — the original error surfaces.
