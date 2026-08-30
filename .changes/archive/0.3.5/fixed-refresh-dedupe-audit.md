---
kind: fixed
summary: Cross-tab refresh coordination now actually deduplicates; onAuthFailure fires once per failed refresh, not once per waiter; defaultParseError no longer crashes on a JSON null body
---

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
