// @andrewpopov/fetch-client-kit/upload
//
// Body uploads with progress and cancellation, layered on the core client's
// public `exchange` seam. This is a physically separate module: the core
// `dist/index.js` never requires it, so a consumer that does not upload never
// loads this code. It keeps no module-level state; everything lives on the
// client it is handed.

import { isAbortError, makeAbortError, raceAbort, throwIfAborted } from './cancellation';
import type { AttemptContext, FetchClient } from './index';

export { isAbortError };

export interface UploadProgress {
  loaded: number;
  /** Undefined when the browser cannot compute the total. */
  total: number | undefined;
}

export type UploadBody = Blob | FormData | ArrayBuffer | ArrayBufferView | URLSearchParams | string;

export interface UploadOptions {
  path: string;
  method: 'POST' | 'PUT' | 'PATCH';
  body: UploadBody;
  headers?: HeadersInit;
  /** Restarts from zero if the upload is resent after a refresh. */
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
  /** Called after a retriable 401, before the refresh and again before the
   * resend or `onAuthFailure`. Throw to stop: the throw rejects `upload`
   * unchanged, and neither the resend nor `onAuthFailure` happens for it. */
  beforeRetry?: () => void;
}

export interface UploadSendRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials?: RequestCredentials;
  body: UploadBody;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

/** One attempt. Resolves a Response for any HTTP status; rejects with a
 * TypeError for a network failure or an AbortError when cancelled. Never retries. */
export type UploadTransport = (request: UploadSendRequest) => Promise<Response>;

/** `UploadOptions` plus how the bytes are sent. */
export interface UploadCall extends UploadOptions {
  /** Defaults to `xhrUploadTransport()` when `XMLHttpRequest` exists (it reports
   * progress), otherwise `fetchUploadTransport(client's fetcher)`. A request whose
   * strategy asks for `credentials: 'omit'` always goes through fetch by default,
   * because XHR cannot omit credentials on a same-origin request. An injected
   * transport is used as given and receives the `credentials` to honour. */
  transport?: UploadTransport;
}

function toRecord(init: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  new Headers(init).forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

const FORBIDDEN_XHR_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
]);

function isForbiddenXhrHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    FORBIDDEN_XHR_HEADERS.has(lower) ||
    lower.startsWith('proxy-') ||
    lower.startsWith('sec-') ||
    lower.startsWith('access-control-request-')
  );
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Uploads over XMLHttpRequest, the only browser API that reports upload
 * progress. `XMLHttpRequest` is resolved on every call so a later stub is honoured. */
export function xhrUploadTransport(): UploadTransport {
  return (request) =>
    new Promise<Response>((resolve, reject) => {
      const { signal } = request;
      if (request.credentials === 'omit') {
        // XHR can only turn credentials off for cross-origin requests, so it cannot honour this.
        reject(new Error("xhrUploadTransport cannot honour credentials: 'omit'; use fetchUploadTransport"));
        return;
      }
      if (signal?.aborted) {
        reject(makeAbortError(signal.reason));
        return;
      }
      const xhr = new XMLHttpRequest();
      let settled = false;
      const onSignalAbort = () => {
        xhr.abort();
        settle(() => reject(makeAbortError(signal?.reason)));
      };
      function settle(finish: () => void) {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onSignalAbort);
        finish();
      }

      try {
        xhr.open(request.method, request.url);
        for (const [name, value] of Object.entries(request.headers)) {
          if (!isForbiddenXhrHeader(name)) xhr.setRequestHeader(name, value);
        }
        xhr.withCredentials = request.credentials === 'include';
        if (request.onProgress) {
          const onProgress = request.onProgress;
          xhr.upload.onprogress = (event) =>
            onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined });
        }
        xhr.onload = () =>
          settle(() => {
            if (xhr.status < 200) {
              reject(new TypeError('Network request failed'));
              return;
            }
            const headers = new Headers();
            for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
              const split = line.indexOf(':');
              if (split > 0) headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim());
            }
            try {
              resolve(
                new Response(NULL_BODY_STATUSES.has(xhr.status) ? null : xhr.responseText, {
                  status: xhr.status,
                  statusText: xhr.statusText,
                  headers,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        xhr.onerror = () => settle(() => reject(new TypeError('Network request failed')));
        xhr.onabort = () => settle(() => reject(makeAbortError(signal?.reason)));
        signal?.addEventListener('abort', onSignalAbort, { once: true });
        xhr.send(request.body as XMLHttpRequestBodyInit);
      } catch (error) {
        settle(() => reject(error));
      }
    });
}

/** Uploads over fetch: no progress events, but it honours every `credentials` mode. */
export function fetchUploadTransport(fetcher: typeof fetch = (input, init) => fetch(input, init)): UploadTransport {
  return async (request) => {
    throwIfAborted(request.signal);
    try {
      return await fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        credentials: request.credentials,
        body: request.body as BodyInit,
        signal: request.signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw makeAbortError(request.signal.reason);
      if (isAbortError(error)) throw makeAbortError(error);
      throw error;
    }
  };
}

/** Send a body through the client's 401 -> refresh -> resend loop, with a
 * progress callback and cancellation. */
export async function upload<T>(client: FetchClient, options: UploadCall): Promise<T> {
  const { path, method, body, headers, onProgress, signal, beforeRetry, transport: explicitTransport } = options;
  throwIfAborted(signal);

  // Normalization covers only the transport attempt and the parse. `exchange`
  // itself stays outside it, so a `beforeRetry` throw reaches the caller by identity.
  async function attempt({ url, fetcher, decorate }: AttemptContext): Promise<Response> {
    const init = decorate({ method, headers, body: body as BodyInit });
    const transport =
      explicitTransport ??
      (init.credentials === 'omit' || typeof XMLHttpRequest === 'undefined'
        ? fetchUploadTransport(fetcher)
        : xhrUploadTransport());
    try {
      return await transport({
        url,
        method,
        headers: toRecord(init.headers),
        credentials: init.credentials,
        body,
        onProgress,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw makeAbortError(signal.reason);
      throw error;
    }
  }

  const response = await client.exchange(path, attempt, { signal, beforeRetry });
  // fetch resolves at the headers, so a cancel can still land while the body
  // is read; `parseError` also swallows body-read failures into a status
  // error. Whatever surfaces after an abort is the cancellation.
  try {
    return await raceAbort(client.parseResponse<T>(response), signal);
  } catch (error) {
    if (signal?.aborted) throw makeAbortError(signal.reason);
    throw error;
  }
}
