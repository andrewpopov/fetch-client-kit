import { isAbortError } from './cancellation';
import type { FetchClient } from './index';
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
/** Uploads over XMLHttpRequest, the only browser API that reports upload
 * progress. `XMLHttpRequest` is resolved on every call so a later stub is honoured. */
export declare function xhrUploadTransport(): UploadTransport;
/** Uploads over fetch: no progress events, but it honours every `credentials` mode. */
export declare function fetchUploadTransport(fetcher?: typeof fetch): UploadTransport;
/** Send a body through the client's 401 -> refresh -> resend loop, with a
 * progress callback and cancellation. */
export declare function upload<T>(client: FetchClient, options: UploadCall): Promise<T>;
