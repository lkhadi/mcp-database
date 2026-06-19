import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isTransientConnectionError, withConnectionRetry } from '../src/db/connection-retry.js';

test('retries once after resetting a transient connection error', async () => {
    let attempts = 0;
    let resets = 0;

    const result = await withConnectionRetry(
        async () => {
            attempts++;
            if (attempts === 1) {
                const error = new Error('Connection lost');
                Object.assign(error, { code: 'ECONNRESET' });
                throw error;
            }
            return 'ok';
        },
        async () => {
            resets++;
        }
    );

    assert.equal(result, 'ok');
    assert.equal(attempts, 2);
    assert.equal(resets, 1);
});

test('does not retry non-connection errors', async () => {
    let attempts = 0;
    let resets = 0;
    const syntaxError = new Error('syntax error');
    Object.assign(syntaxError, { code: '42601' });

    await assert.rejects(
        () =>
            withConnectionRetry(
                async () => {
                    attempts++;
                    throw syntaxError;
                },
                async () => {
                    resets++;
                }
            ),
        syntaxError
    );

    assert.equal(attempts, 1);
    assert.equal(resets, 0);
});

test('returns the retry error when the connection remains unavailable', async () => {
    let attempts = 0;

    await assert.rejects(
        () =>
            withConnectionRetry(
                async () => {
                    attempts++;
                    const error = new Error(`connect failed ${attempts}`);
                    Object.assign(error, { code: 'ECONNREFUSED' });
                    throw error;
                },
                async () => {}
            ),
        /connect failed 2/
    );

    assert.equal(attempts, 2);
});

test('still retries after a transient error when connection reset fails', async () => {
    let attempts = 0;

    const result = await withConnectionRetry(
        async () => {
            attempts++;
            if (attempts === 1) {
                const error = new Error('Connection lost');
                Object.assign(error, { code: 'ECONNRESET' });
                throw error;
            }
            return 'fresh pool result';
        },
        async () => {
            throw new Error('pool close failed');
        }
    );

    assert.equal(result, 'fresh pool result');
    assert.equal(attempts, 2);
});

test('classifies common MySQL and PostgreSQL connection errors as transient', () => {
    assert.equal(isTransientConnectionError({ code: 'PROTOCOL_CONNECTION_LOST' }), true);
    assert.equal(isTransientConnectionError({ code: 'PROTOCOL_SEQUENCE_TIMEOUT' }), true);
    assert.equal(isTransientConnectionError({ code: '08006' }), true);
    assert.equal(isTransientConnectionError({ code: '42601' }), false);
});

test('classifies pool and driver timeout messages as transient', () => {
    assert.equal(isTransientConnectionError(new Error('Client was closed and is not queryable')), true);
    assert.equal(isTransientConnectionError(new Error('connection timeout exceeded')), true);
    assert.equal(isTransientConnectionError(new Error('Query read timeout')), true);
    assert.equal(isTransientConnectionError(new Error('Cannot enqueue Query after fatal error')), true);
});

test('keeps syntax and permission messages non-transient', () => {
    assert.equal(isTransientConnectionError(new Error('syntax error at or near "FROM"')), false);
    assert.equal(isTransientConnectionError({ code: '42501', message: 'permission denied for table users' }), false);
});
