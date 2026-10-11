/** The one cancellation error the kit rejects with, whatever aborted it. */
export declare function makeAbortError(cause?: unknown): Error;
export declare function isAbortError(error: unknown): error is {
    name: 'AbortError';
};
export declare function throwIfAborted(signal: AbortSignal | undefined): void;
export declare function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T>;
