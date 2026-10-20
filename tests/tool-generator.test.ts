import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionManager } from '../src/db/connection-manager.js';
import type { DatabaseAdapter } from '../src/db/types.js';
import { DatabaseConfigSchema } from '../src/config/schema.js';
import { connectTools } from './helpers/mcp.js';

test('listing keeps explicit SSH lazy and includes healthy peers when discovery is unavailable', async (t) => {
    const manager = new ConnectionManager();
    let tunnelCalls = 0;
    const mutable = manager as unknown as {
        tunnelManager: object;
        createAdapter: () => DatabaseAdapter;
    };
    mutable.tunnelManager = {
        async register() { return null; },
        async ensureConnected() { tunnelCalls++; throw new Error('must stay lazy'); },
        async closeAll() {},
    };
    mutable.createAdapter = () => ({
        type: 'mysql',
        async execute() { throw new Error('must not execute'); },
        async listDatabases() { throw new Error('database remains offline'); },
        async listTables() { return []; },
        async describeTable() { return []; },
        async close() {},
    });
    const base = { type: 'mysql', host: 'unused.invalid', port: 3306, username: 'test', password: 'fake' };
    await manager.initialize([
        DatabaseConfigSchema.parse({ ...base, id: 'lazy', databases: ['app'], ssh: {
            enabled: true, lazy: true, host: 'unused.invalid', username: 'test', targetHost: 'unused.invalid', targetPort: 3306,
        } }),
        DatabaseConfigSchema.parse({ ...base, id: 'offline', databases: '*' }),
    ]);
    const tools = await connectTools(manager);
    t.after(async () => { await tools.close(); await manager.closeAll(); });
    const result = await tools.client.callTool({ name: 'list_databases', arguments: {} });
    assert.match(JSON.stringify(result.content), /app/);
    assert.match(JSON.stringify(result.content), /database remains offline/);
    const denied = await tools.client.callTool({ name: 'execute_sql', arguments: {
        connection: 'lazy', database: 'secret', sql: 'SELECT 1',
    } });
    assert.equal(denied.isError, true);
    assert.equal(tunnelCalls, 0);
});

for (const firstUse of ['execute', 'list', 'manager'] as const) {
    test(`MCP wildcard discovery recovers after startup failure through ${firstUse}`, async (t) => {
        const manager = new ConnectionManager();
        let discovery = 0;
        let executed = 0;
        const adapter: DatabaseAdapter = {
            type: 'postgresql',
            async execute() { executed++; return { rows: [{ ok: 1 }], fields: ['ok'], rowCount: 1 }; },
            async listDatabases() {
                if (++discovery === 1) throw new Error('offline at startup');
                return ['app'];
            },
            async listTables() { return []; },
            async describeTable() { return []; },
            async close() {},
        };
        (manager as unknown as { createAdapter: () => DatabaseAdapter }).createAdapter = () => adapter;
        await manager.initialize([DatabaseConfigSchema.parse({
            id: 'test', type: 'postgresql', host: 'unused.invalid', port: 5432,
            username: 'test', password: 'fake', databases: '*',
        })]);
        const tools = await connectTools(manager);
        t.after(async () => { await tools.close(); await manager.closeAll(); });
        if (firstUse === 'manager') await manager.getConnectionAsync('test');
        if (firstUse === 'list' || firstUse === 'manager') {
            const listed = await tools.client.callTool({ name: 'list_databases', arguments: {} });
            assert.match(JSON.stringify(listed.content), /app/);
        }
        const result = await tools.client.callTool({ name: 'execute_sql', arguments: {
            connection: 'test', database: 'app', sql: 'SELECT 1',
        } });
        assert.notEqual(result.isError, true);
        assert.equal(discovery, 2);
        assert.equal(executed, 1);
        const denied = await tools.client.callTool({ name: 'execute_sql', arguments: {
            connection: 'test', database: 'secret', sql: 'SELECT 1',
        } });
        assert.equal(denied.isError, true);
        assert.equal(executed, 1);
    });
}

test('MCP rejects hidden dangerous SQL before invoking the adapter', async (t) => {
    const manager = new ConnectionManager();
    let executed = 0;
    const adapter: DatabaseAdapter = {
        type: 'postgresql',
        async execute() { executed++; return { rows: [{ ok: 1 }], fields: ['ok'], rowCount: 1 }; },
        async listDatabases() { return ['app']; },
        async listTables() { return []; },
        async describeTable() { return []; },
        async close() {},
    };
    (manager as unknown as { createAdapter: () => DatabaseAdapter }).createAdapter = () => adapter;
    await manager.initialize([DatabaseConfigSchema.parse({
        id: 'test', type: 'postgresql', host: 'unused.invalid', port: 5432,
        username: 'test', password: 'fake', databases: ['app'],
    })]);
    const tools = await connectTools(manager);
    t.after(async () => { await tools.close(); await manager.closeAll(); });
    assert.equal((await tools.client.listTools()).tools.length, 2);
    const rejected = await tools.client.callTool({ name: 'execute_sql', arguments: {
        connection: 'test', database: 'app', sql: "SELECT '--'; DROP TABLE example",
    } });
    assert.equal(rejected.isError, true);
    assert.equal(executed, 0);
    const allowed = await tools.client.callTool({ name: 'execute_sql', arguments: {
        connection: 'test', database: 'app', sql: 'SELECT $$DROP --$$',
    } });
    assert.notEqual(allowed.isError, true);
    assert.equal(executed, 1);
    const unprotected = await connectTools(manager, false);
    t.after(() => unprotected.close());
    const batch = await unprotected.client.callTool({ name: 'execute_sql', arguments: {
        connection: 'test', database: 'app', sql: 'SELECT 1; SELECT 2',
    } });
    assert.equal(batch.isError, true);
    assert.match(JSON.stringify(batch.content), /one SQL statement/i);
    assert.equal(executed, 1);
});
