---
kind: added
summary: upload(): send a body through the shared 401 -> refresh -> resend loop, with progress, cancellation and a transport seam
---

`createFetchClient(...).upload()` sends a Blob, FormData, buffer, URLSearchParams or string through the same single-flight refresh loop as `request()`. It re-decorates each attempt, reports progress, and rejects every cancellation with a named `AbortError`. `uploadTransport`, `xhrUploadTransport`, `fetchUploadTransport` and `isAbortError` are new exports.
