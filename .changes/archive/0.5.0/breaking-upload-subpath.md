---
kind: breaking
summary: Upload moves to the @andrewpopov/fetch-client-kit/upload subpath on a public exchange() seam
---

Removed from v0.4.0: `FetchClient.upload`, the `uploadTransport` client option, and the root exports `xhrUploadTransport` and `fetchUploadTransport`. Replacements: `upload(client, { ...options, transport })`, `xhrUploadTransport` and `fetchUploadTransport` from `@andrewpopov/fetch-client-kit/upload`, a separate file the root never loads. `isAbortError` stays a root export and is re-exported from `/upload`. Added: `client.exchange(path, attempt, guard?)`, the public 401 -> refresh -> resend loop that hands each attempt `{ url, fetcher, decorate }`, and `client.parseResponse(response)`, the parse `request` applies.
