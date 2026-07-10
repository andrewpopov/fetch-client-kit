# Changelog

All notable changes to `@andrewpopov/fetch-client-kit`. Versions are git tags
(`vX.Y.Z`); see STANDARDS.md.

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
