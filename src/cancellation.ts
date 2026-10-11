// Cancellation helpers shared by the core exchange loop and the `/upload`
// subpath. Deliberately transport-free: nothing here may reference XHR or any
// upload code, because the core module requires this file.

/** The one cancellation error the kit rejects with, whatever aborted it. */
export function makeAbortError(cause?: unknown): Error {
  const message = 'Upload cancelled';
  let error: Error;
  if (typeof DOMException === 'function') {
    error = new DOMException(message, 'AbortError');
  } else {
    error = new Error(message);
    error.name = 'AbortError';
  }
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause, configurable: true });
  return error;
}

export function isAbortError(error: unknown): error is { name: 'AbortError' } {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw makeAbortError(signal.reason);
}

// Rejects as soon as `signal` aborts WITHOUT cancelling `promise`: the refresh is
// shared single-flight, so a cancelled waiter must not take it from live ones.
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
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
