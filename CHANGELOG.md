# Changelog

## 0.3.5

- Release tooling upgraded to release-kit v0.3.1, so a feature release is graded as a minor rather than a patch
  This package's release-kit was pinned at v0.2.0, whose `stableSemver` incremented the patch component regardless of fragment kind — measured directly, a `minor` and even a `major` bump both resolved to a patch, and `bumpLevelSupport` was absent. Any release adding public surface would therefore have been published as a patch, telling every consumer the upgrade added nothing. That was not hypothetical: during the PKG-114 cuts, alert-kit on v0.2.0 derived 0.5.1 for a release that added a whole new public module, caught only because the derived version was read before cutting.
  
  No runtime change — release-kit is a devDependency and nothing this package exports is affected.
- cross-tab followers now settle safely when token adoption fails
  A throwing `onTokenReceived` callback now produces an immediate failed refresh
  outcome for the follower without leaving it waiting or causing a redundant
  refresh request.
- Cross-tab refresh coordination now actually deduplicates; onAuthFailure fires once per failed refresh, not once per waiter; defaultParseError no longer crashes on a JSON null body
  Three findings from a completeness audit (PKG-142), all confirmed against the
  code before fixing:
  
  `bearerAuth`'s `crossTabRefresh` documented that "only one tab refreshes and
  siblings adopt its token," but every tab called the refresh endpoint
  immediately on its own `401` — the channel only broadcast the result
  afterward, so two simultaneous tab-level `401`s still fired two refresh
  requests. Against a backend that rotates refresh tokens on use (the standard,
  and what `@andrewpopov/auth-kit`'s `rotateRefreshToken` does), that is exactly
  the pattern that trips reuse detection and can revoke the whole session
  family for what was a benign race. `bearerAuth` now runs a real
  `refresh-start`/`refresh-done` protocol over `BroadcastChannel`: a tab
  broadcasts before calling the endpoint, and a sibling that sees a refresh
  already in flight awaits its outcome — success or failure — instead of also
  calling it, with a `leaderTimeoutMs` (default 4000ms) so a follower never
  hangs on a leader tab that crashed, closed, or stalled. `BroadcastChannel` has
  no election primitive, so two tabs claiming leadership at the exact same
  instant can still both proceed — the README is now explicit that this is "at
  most one refresh in the common case, correct in all cases," not a race-free
  guarantee.
  
  Concurrent `401`s already shared one refresh attempt via the single-flight
  dedup, but each waiting request independently called `onAuthFailure()` once
  that shared attempt failed — 8 concurrent requests meant 8 calls to a hook
  whose job is typically to wipe local state and redirect to login. It now
  fires exactly once per failed refresh attempt regardless of how many
  requests were waiting on it, matching what the README already promised.
  
  `defaultParseError` read `body.error || body.message` on the parsed JSON
  body of a non-ok response. A body that is the literal JSON value `null` (or
  any other non-object JSON, e.g. an array) parses successfully — nothing for
  the existing `.catch()` fallback to catch — so that property read threw a
  TypeError before the promised status-bearing `Error` was ever constructed;
  callers got an unrelated crash instead of a rejection carrying `.status`. The
  parsed body is now checked to be a non-null, non-array object before either
  property is read.

## 0.3.4

- Manage releases with release-kit (fragment-based CHANGELOG + version bump)
  Releases are now driven by release-kit: describe each change as a fragment
  under `.changes/unreleased/` and run `npm run release:cut` to compile them
  into a new CHANGELOG section, bump the version, and archive the fragments.

## 0.3.3

- Add public contribution, support, and private vulnerability-reporting policies.
- **Correctness — preserve every standard `HeadersInit` form.** Built-in auth
  strategies previously spread `request.headers` as a plain object. A native
  `Headers` instance (and tuple-array headers) therefore lost its values when
  the strategy decorated the request. Headers now normalize through `Headers`
  before auth/content-type headers are applied; a regression test covers the
  native `Headers` case.
- **Reliability — protect request errors from `onAuthFailure`.** This callback
  is an observer for auth-state cleanup and redirects. If it throws, the client
  now still rejects with the original failed request error.
- **Developer experience — add `npm run verify`.** The documented local gate
  runs type checking, tests, build, and tarball-install export verification.
- **Developer security — upgrade Vitest** to a version with no known advisories.

## 0.3.2

Fix — expose `./package.json` in the `exports` map. Without it,
`require('@andrewpopov/fetch-client-kit/package.json')` threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` — which broke the standards' own documented way of
verifying an INSTALLED version, the guard against the `github:` re-resolve trap.

No runtime change.

## 0.3.1

**Testability fix.** `createFetchClient`'s default fetcher was `fetcher = fetch`,
a default parameter that captures the **current global `fetch` at construction
time**. Every consumer builds its client at module scope — before any test stubs
`globalThis.fetch` — so the client **bypassed the stub and sent real network
traffic from the test suite**, silently.

Found while adopting the package in sano-os: `apiGet` reached the network and
failed with `TypeError: Failed to parse URL from /api/goals` instead of hitting
the mock. sano-os patched around it locally; the fix belongs here, because every
consumer that stubs `fetch` in tests has the same latent problem.

The default is now late-bound (`(input, init) => fetch(input, init)`), so a stub
installed after construction is honoured. Passing an explicit `fetcher` is
unchanged. Pinned by a regression test that fails against the old default.

All notable changes to `@andrewpopov/fetch-client-kit`. Versions are git tags
(`vX.Y.Z`); see STANDARDS.md.

## 0.3.0

- **Feature — `crossTabRefresh` on `bearerAuth`.** Opt-in, off by default;
  v0.2.0 behaviour is unchanged when the option is omitted. When set, the
  strategy opens a `BroadcastChannel` under the given `channelName`; a
  successful refresh broadcasts the freshly-stored access token so sibling
  tabs (same origin, same channel name) can adopt it via `onTokenReceived`
  instead of each independently hammering the refresh endpoint. Degrades
  silently when `BroadcastChannel` is unavailable (SSR, old browsers) —
  never throws. `bearerAuth` now returns a `close()` alongside `decorate`/
  `refresh` to dispose of the channel (tests, hot-reload).
  This is a **nicety, not a security control** — the server-side rotation
  grace window remains the authoritative defense against the benign refresh
  race; BroadcastChannel just saves redundant refresh calls. Only the
  short-lived access token is ever broadcast, never a refresh token — the
  package never has one to begin with (bearerAuth only handles the access
  token via `getAccessToken`/`onRefreshed`). Scoped to `bearerAuth`: `cookieAuth`
  and `csrfAuth` rely on the browser's session cookie, which is already shared
  across tabs, so there is nothing to broadcast. Merged up from sano-os's
  local `api.ts`/`auth.ts`, which had this and kept its access token in
  memory only (never localStorage) — motivating why the feature lives on
  `bearerAuth`, the one strategy with an in-tab token.

## 0.2.0

- **Fix — FormData bodies no longer get `Content-Type` forced.** All three
  strategies set `Content-Type: application/json` unconditionally, which corrupts
  a multipart upload: the browser must set `Content-Type` itself so it can include
  the `boundary=` parameter. Now the JSON content-type is added only when the body
  is not a `FormData` and the caller has not already set one. Found migrating
  savoro, whose `postForm` sends FormData (Standard 1: superset before adoption).
- **Feature — `onAuthFailure`** on `createFetchClient`: called once when a refresh
  fails on a retriable 401, so a consumer can clear auth state and redirect to
  login. The original request still rejects with its own error.

## 0.1.0

Initial extraction (BWK-138). One 401-refresh-retry transport with a pluggable
`AuthStrategy`, replacing three hand-rolled copies (smarthome `api-client-kit`,
savoro `web-app/.../client.ts`, towerpower `apps/web/.../apiClient.ts`) that
differed only in how auth attaches to a request.

- `createFetchClient({ baseUrl, auth, fetcher?, authPathPrefixes?, parseError? })`
- Built-in strategies: `cookieAuth`, `bearerAuth`, `csrfAuth`.
- **Single-flight refresh**: N concurrent `401`s trigger exactly one refresh, all
  retry once. Pinned by a load-bearing concurrency test.
- Auth-endpoint `401`s never trigger a refresh; a failed refresh surfaces the
  original error; empty (204) bodies resolve to `undefined`.
