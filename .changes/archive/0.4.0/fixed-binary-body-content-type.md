---
kind: fixed
summary: Blob, ArrayBuffer, typed array, URLSearchParams and ReadableStream bodies no longer get a forced application/json Content-Type
---

The built-in strategies forced `Content-Type: application/json` on every body except FormData, which corrupts a Blob or buffer upload. Self-typed bodies now keep the platform's own type; string bodies still default to JSON.
