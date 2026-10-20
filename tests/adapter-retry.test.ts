import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stubDriver, writeResult, connectionLost } from './helpers/adapters.js';

for (const type of ['mysql', 'postgresql'] as const) {
    test(`${type} does not replay a SELECT with side effects on the second connection attempt`, async () => {
        let acquisitions = 0;
        let submitted = 0;
        const driver = stubDriver(type, async (sql) => {
            if (sql.startsWith('SET ')) return {};
            submitted++;
            throw connectionLost();
        }, async () => {
            if (++acquisitions === 1) throw connectionLost();
        });
        await assert.rejects(() => driver.adapter.execute('SELECT mutating_function()', 'app'), /outcome is unknown/i);
        assert.equal(acquisitions, 2);
        assert.equal(submitted, 1);
        assert.equal(driver.ended, 2);
    });

    test(`${type} never replays submitted SQL after losing its response`, async () => {
        let writes = 0;
        const driver = stubDriver(type, async (sql) => {
            if (sql.startsWith('SET ')) return {};
            writes++;
            if (writes === 1) throw connectionLost();
            return writeResult(type);
        });
        await assert.rejects(() => driver.adapter.execute('UPDATE counters SET value = value + 1', 'app'), /outcome is unknown/i);
        assert.equal(writes, 1);
        assert.equal(driver.released, 1);
        assert.equal(driver.ended, 1);
        await driver.adapter.execute('UPDATE counters SET value = value + 1', 'app');
        assert.equal(writes, 2, 'a later explicit request remains usable');
    });

    for (const failure of ['acquire', 'setup'] as const) {
        test(`${type} retries ${failure} errors before SQL submission`, async () => {
            let acquisitions = 0;
            let setups = 0;
            let writes = 0;
            const driver = stubDriver(type, async (sql) => {
                if (sql.startsWith('SET ')) {
                    setups++;
                    if (failure === 'setup' && setups === 1) throw connectionLost();
                    return {};
                }
                writes++;
                return writeResult(type);
            }, async () => {
                acquisitions++;
                if (failure === 'acquire' && acquisitions === 1) throw connectionLost();
            });
            assert.equal((await driver.adapter.execute('INSERT INTO example VALUES (1)', 'app')).affectedRows, 1);
            assert.equal(acquisitions, 2);
            assert.equal(writes, 1);
        });
    }

    test(`${type} preserves ordinary SQL errors without retry`, async () => {
        const error = Object.assign(new Error('syntax error'), { code: '42601' });
        let calls = 0;
        const driver = stubDriver(type, async (sql) => {
            if (sql.startsWith('SET ')) return {};
            calls++;
            throw error;
        });
        await assert.rejects(() => driver.adapter.execute('invalid sql', 'app'), (actual) => actual === error);
        assert.equal(calls, 1);
        assert.equal(driver.ended, 0);
    });
}
