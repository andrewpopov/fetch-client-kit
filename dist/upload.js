"use strict";
// @andrewpopov/fetch-client-kit/upload
//
// Body uploads with progress and cancellation, layered on the core client's
// public `exchange` seam. This is a physically separate module: the core
// `dist/index.js` never requires it, so a consumer that does not upload never
// loads this code. It keeps no module-level state; everything lives on the
// client it is handed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isAbortError = void 0;
exports.xhrUploadTransport = xhrUploadTransport;
exports.fetchUploadTransport = fetchUploadTransport;
exports.upload = upload;
const cancellation_1 = require("./cancellation");
Object.defineProperty(exports, "isAbortError", { enumerable: true, get: function () { return cancellation_1.isAbortError; } });
function toRecord(init) {
    const record = {};
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
function isForbiddenXhrHeader(name) {
    const lower = name.toLowerCase();
    return (FORBIDDEN_XHR_HEADERS.has(lower) ||
        lower.startsWith('proxy-') ||
        lower.startsWith('sec-') ||
        lower.startsWith('access-control-request-'));
}
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/** Uploads over XMLHttpRequest, the only browser API that reports upload
 * progress. `XMLHttpRequest` is resolved on every call so a later stub is honoured. */
function xhrUploadTransport() {
    return (request) => new Promise((resolve, reject) => {
        const { signal } = request;
        if (request.credentials === 'omit') {
            // XHR can only turn credentials off for cross-origin requests, so it cannot honour this.
            reject(new Error("xhrUploadTransport cannot honour credentials: 'omit'; use fetchUploadTransport"));
            return;
        }
        if (signal?.aborted) {
            reject((0, cancellation_1.makeAbortError)(signal.reason));
            return;
        }
        const xhr = new XMLHttpRequest();
        let settled = false;
        const onSignalAbort = () => {
            xhr.abort();
            settle(() => reject((0, cancellation_1.makeAbortError)(signal?.reason)));
        };
        function settle(finish) {
            if (settled)
                return;
            settled = true;
            signal?.removeEventListener('abort', onSignalAbort);
            finish();
        }
        try {
            xhr.open(request.method, request.url);
            for (const [name, value] of Object.entries(request.headers)) {
                if (!isForbiddenXhrHeader(name))
                    xhr.setRequestHeader(name, value);
            }
            xhr.withCredentials = request.credentials === 'include';
            if (request.onProgress) {
                const onProgress = request.onProgress;
                xhr.upload.onprogress = (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : undefined });
            }
            xhr.onload = () => settle(() => {
                if (xhr.status < 200) {
                    reject(new TypeError('Network request failed'));
                    return;
                }
                const headers = new Headers();
                for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
                    const split = line.indexOf(':');
                    if (split > 0)
                        headers.append(line.slice(0, split).trim(), line.slice(split + 1).trim());
                }
                try {
                    resolve(new Response(NULL_BODY_STATUSES.has(xhr.status) ? null : xhr.responseText, {
                        status: xhr.status,
                        statusText: xhr.statusText,
                        headers,
                    }));
                }
                catch (error) {
                    reject(error);
                }
            });
            xhr.onerror = () => settle(() => reject(new TypeError('Network request failed')));
            xhr.onabort = () => settle(() => reject((0, cancellation_1.makeAbortError)(signal?.reason)));
            signal?.addEventListener('abort', onSignalAbort, { once: true });
            xhr.send(request.body);
        }
        catch (error) {
            settle(() => reject(error));
        }
    });
}
/** Uploads over fetch: no progress events, but it honours every `credentials` mode. */
function fetchUploadTransport(fetcher = (input, init) => fetch(input, init)) {
    return async (request) => {
        (0, cancellation_1.throwIfAborted)(request.signal);
        try {
            return await fetcher(request.url, {
                method: request.method,
                headers: request.headers,
                credentials: request.credentials,
                body: request.body,
                signal: request.signal,
            });
        }
        catch (error) {
            if (request.signal?.aborted)
                throw (0, cancellation_1.makeAbortError)(request.signal.reason);
            if ((0, cancellation_1.isAbortError)(error))
                throw (0, cancellation_1.makeAbortError)(error);
            throw error;
        }
    };
}
/** Send a body through the client's 401 -> refresh -> resend loop, with a
 * progress callback and cancellation. */
async function upload(client, options) {
    const { path, method, body, headers, onProgress, signal, beforeRetry, transport: explicitTransport } = options;
    (0, cancellation_1.throwIfAborted)(signal);
    // Normalization covers only the transport attempt and the parse. `exchange`
    // itself stays outside it, so a `beforeRetry` throw reaches the caller by identity.
    async function attempt({ url, fetcher, decorate }) {
        const init = decorate({ method, headers, body: body });
        const transport = explicitTransport ??
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
        }
        catch (error) {
            if (signal?.aborted)
                throw (0, cancellation_1.makeAbortError)(signal.reason);
            throw error;
        }
    }
    const response = await client.exchange(path, attempt, { signal, beforeRetry });
    // fetch resolves at the headers, so a cancel can still land while the body
    // is read; `parseError` also swallows body-read failures into a status
    // error. Whatever surfaces after an abort is the cancellation.
    try {
        return await (0, cancellation_1.raceAbort)(client.parseResponse(response), signal);
    }
    catch (error) {
        if (signal?.aborted)
            throw (0, cancellation_1.makeAbortError)(signal.reason);
        throw error;
    }
}
