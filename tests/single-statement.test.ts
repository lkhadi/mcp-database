import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stubDriver, writeResult } from './helpers/adapters.js';

for (const type of ['mysql', 'postgresql'] as const) {
    for (const sql of ['SELECT 1; SELECT 2', ' ; /* empty */ ;', '/*! SELECT 1; SELECT 2 */']) {
        test(`${type} rejects unsupported statement input before acquiring a client: ${sql}`, async () => {
            let acquisitions = 0;
            const driver = stubDriver(type, async () => writeResult(type), async () => { acquisitions++; });
            await assert.rejects(() => driver.adapter.execute(sql, 'app'), /statement|comment/i);
            assert.equal(acquisitions, 0);
        });
    }
    const allowed = type === 'mysql'
        ? ["SELECT ';' AS value; -- end", 'SELECT `semi;colon` FROM example;']
        : ["SELECT ';' AS value; -- end", 'SELECT $$hello;world$$;', 'DO $$ BEGIN RAISE NOTICE \'hello;world\'; END $$;'];
    for (const sql of allowed) {
        test(`${type} permits delimiters inside quoted tokens: ${sql}`, async () => {
            let submitted = 0;
            const driver = stubDriver(type, async (text) => {
                if (text.startsWith('SET ')) return {};
                submitted++;
                return writeResult(type);
            });
            await driver.adapter.execute(sql, 'app');
            assert.equal(submitted, 1);
        });
    }
    test(`${type} reports unsupported result sets without pretending zero rows were affected`, async () => {
        let submitted = 0;
        const driver = stubDriver(type, async (sql) => {
            if (sql.startsWith('SET ')) return {};
            submitted++;
            return type === 'mysql'
                ? [[[{ x: 1 }], { affectedRows: 1 }], [[{ name: 'x' }], undefined]]
                : [{ rows: [{ x: 1 }], fields: [{ name: 'x' }], rowCount: 1 }, { rows: [], fields: [], rowCount: 1 }];
        });
        await assert.rejects(() => driver.adapter.execute('CALL example()', 'app'), /executed.*multiple result sets/i);
        assert.equal(submitted, 1);
    });
}
