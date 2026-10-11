"use strict";
// Cancellation helpers shared by the core exchange loop and the `/upload`
// subpath. Deliberately transport-free: nothing here may reference XHR or any
// upload code, because the core module requires this file.
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeAbortError = makeAbortError;
exports.isAbortError = isAbortError;
exports.throwIfAborted = throwIfAborted;
exports.raceAbort = raceAbort;
/** The one cancellation error the kit rejects with, whatever aborted it. */
function makeAbortError(cause) {
    const message = 'Upload cancelled';
    let error;
    if (typeof DOMException === 'function') {
        error = new DOMException(message, 'AbortError');
    }
    else {
        error = new Error(message);
        error.name = 'AbortError';
    }
    if (cause !== undefined)
        Object.defineProperty(error, 'cause', { value: cause, configurable: true });
    return error;
}
function isAbortError(error) {
    return typeof error === 'object' && error !== null && error.name === 'AbortError';
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw makeAbortError(signal.reason);
}
// Rejects as soon as `signal` aborts WITHOUT cancelling `promise`: the refresh is
// shared single-flight, so a cancelled waiter must not take it from live ones.
function raceAbort(promise, signal) {
    if (!signal)
        return promise;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(makeAbortError(signal.reason));
        // Always observe `promise`: an already-aborted signal returns below, and
        // its later rejection would otherwise be an unhandled rejection.
        promise.catch(() => undefined);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}
