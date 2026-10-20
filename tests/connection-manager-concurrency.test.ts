import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectionManager } from '../src/db/connection-manager.js';
import { DatabaseConfigSchema } from '../src/config/schema.js';
import type { DatabaseAdapter } from '../src/db/types.js';
import { deferred, sshConfig } from './helpers/lifecycle.js';

function fixture() {
    const manager = new ConnectionManager();
    const adapters: Array<DatabaseAdapter & { closes: number }> = [];
    let recoveries = 0;
    const endpoint = { localHost: '127.0.0.1', localPort: 40000, targetHost: 'db.invalid', targetPort: 3306, isConnected: true };
    const tunnel = {
        async register() { return null; },
        async ensureConnected() { return endpoint; },
        async reconnect() { recoveries++; return endpoint; },
        async closeAll() {},
    };
    const mutable = manager as unknown as { tunnelManager: typeof tunnel; createAdapter: () => DatabaseAdapter };
    mutable.tunnelManager = tunnel;
    mutable.createAdapter = () => {
        const adapter: DatabaseAdapter & { closes: number } = {
            type: 'mysql', closes: 0,
            async execute() { return { rows: [], fields: [], rowCount: 0 }; },
            async listDatabases() { return ['app']; },
            async listTables() { return []; },
            async describeTable() { return []; },
            async close() { this.closes++; },
        };
        adapters.push(adapter);
        return adapter;
    };
    const config = DatabaseConfigSchema.parse({ id: 'test', type: 'mysql', host: 'db.invalid', port: 3306, username: 'test', password: 'fake', databases: ['app'], ssh: sshConfig });
    return { manager, adapters, tunnel, config, get recoveries() { return recoveries; } };
}

test('parallel lazy requests create one managed adapter', async () => {
    const f = fixture();
    await f.manager.initialize([f.config]);
    await Promise.all([f.manager.getConnectionAsync('test'), f.manager.getConnectionAsync('test')]);
    await f.manager.closeAll();
    assert.equal(f.adapters.length, 1);
    assert.equal(f.adapters[0].closes, 1);
});

test('simultaneous failures share recovery without closing the replacement', async () => {
    const f = fixture();
    await f.manager.initialize([f.config]);
    const connection = await f.manager.getConnectionAsync('test');
    f.adapters[0].execute = async () => { throw Object.assign(new Error('connection unavailable before submission'), { code: 'ECONNRESET' }); };
    await Promise.all([connection!.adapter.execute('SELECT 1', 'app'), connection!.adapter.execute('SELECT 2', 'app')]);
    assert.equal(f.recoveries, 1);
    assert.equal(f.adapters.length, 2);
    assert.equal(f.adapters[0].closes, 1);
    assert.equal(f.adapters[1].closes, 0);
    await f.manager.closeAll();
    assert.equal(f.adapters[1].closes, 1);
});

test('shutdown prevents late adapter publication', async () => {
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.tunnel.ensureConnected>>>();
    const entered = deferred<void>();
    f.tunnel.ensureConnected = async () => { entered.resolve(); return pending.promise; };
    await f.manager.initialize([f.config]);
    const connecting = f.manager.getConnectionAsync('test');
    const rejected = assert.rejects(connecting, /closed|shut/i);
    await entered.promise;
    const closing = f.manager.closeAll();
    pending.resolve({ localHost: '127.0.0.1', localPort: 40000, targetHost: 'db.invalid', targetPort: 3306, isConnected: true });
    await Promise.all([rejected, closing]);
    assert.equal(f.manager.getAllConnections().length, 0);
    assert.ok(f.adapters.every((adapter) => adapter.closes === 1));
});
