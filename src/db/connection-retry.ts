const TRANSIENT_ERROR_CODES = new Set([
    '08000',
    '08001',
    '08003',
    '08004',
    '08006',
    '08007',
    '57P01',
    '57P02',
    '57P03',
    '53300',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_PACKETS_OUT_OF_ORDER',
    'PROTOCOL_SEQUENCE_TIMEOUT',
]);

/** SQL may have committed before its response was lost. Never replay it. */
export class QueryOutcomeUnknownError extends Error {
    constructor(cause: unknown) {
        super('Connection lost after SQL submission; query outcome is unknown. SQL was not retried. Check the database before retrying.', { cause });
        this.name = 'QueryOutcomeUnknownError';
    }
}

interface ErrorWithConnectionCode {
    code?: unknown;
    errno?: unknown;
    fatal?: unknown;
    message?: unknown;
}

export function isTransientConnectionError(error: unknown): boolean {
    if (error instanceof QueryOutcomeUnknownError) return true;
    if (!error || typeof error !== 'object') {
        return false;
    }

    const err = error as ErrorWithConnectionCode;
    const code = typeof err.code === 'string' ? err.code : undefined;
    if (code && TRANSIENT_ERROR_CODES.has(code)) {
        return true;
    }

    const errno = typeof err.errno === 'string' ? err.errno : undefined;
    if (errno && TRANSIENT_ERROR_CODES.has(errno)) {
        return true;
    }

    if (err.fatal === true) {
        return true;
    }

    const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    return (
        message.includes('connection terminated unexpectedly') ||
        message.includes('connection closed unexpectedly') ||
        message.includes('connection timeout') ||
        message.includes('connection is closed') ||
        message.includes('connection is in closed state') ||
        message.includes('server closed the connection unexpectedly') ||
        message.includes('server closed the connection') ||
        message.includes('terminating connection due to administrator command') ||
        message.includes('client was closed') ||
        message.includes('client has already been closed') ||
        message.includes('client has encountered a connection error') ||
        message.includes('not queryable') ||
        message.includes('query read timeout') ||
        message.includes('read timeout') ||
        message.includes('sequence timeout') ||
        message.includes('cannot enqueue query after fatal error')
    );
}

export async function withConnectionRetry<T>(
    operation: () => Promise<T>,
    resetConnection: () => Promise<void>
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (!isTransientConnectionError(error)) throw error;

            try {
                await resetConnection();
            } catch {
                // Cleanup must not mask the original failure or unknown outcome.
            }
            if (error instanceof QueryOutcomeUnknownError || attempt === 1) throw error;
        }
    }
}
