import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConnectionManager } from '../src/db/connection-manager.js';
import type { DatabaseConfig } from '../src/config/schema.js';
import type { DatabaseAdapter, QueryResultData } from '../src/db/types.js';
import type { TunnelInfo } from '../src/ssh/tunnel-manager.js';

type AdapterFactory = (config: DatabaseConfig, tunnelInfo: TunnelInfo | null) => DatabaseAdapter;

function lazySshConfig(): DatabaseConfig {
    return {
        id: 'ssh_mysql',
        type: 'mysql',
        host: 'db.internal',
        port: 3306,
        username: 'db_user',
        password: 'db_pass',
        databases: ['app'],
        ssh: {
            enabled: true,
            lazy: true,
            host: 'ssh.internal',
            port: 22,
            username: 'ssh_user',
            targetHost: 'db.internal',
            targetPort: 3306,
        },
        connectionLimit: 10,
        connectTimeout: 30000,
        queryTimeout: 60000,
    };
}

function tunnelInfo(localPort: number): TunnelInfo {
    return {
        localHost: '127.0.0.1',
        localPort,
        targetHost: 'db.internal',
        targetPort: 3306,
        isConnected: true,
    };
}

class StubTunnelManager {
    ensureCalls = 0;
    reconnectCalls = 0;

    constructor(
        private readonly initialTunnel: TunnelInfo,
        private readonly recoveredTunnel: TunnelInfo
    ) {}

    async register(): Promise<TunnelInfo | null> {
        return null;
    }

    async ensureConnected(): Promise<TunnelInfo> {
        this.ensureCalls++;
        return this.initialTunnel;
    }

    async reconnect(): Promise<TunnelInfo> {
        this.reconnectCalls++;
        return this.recoveredTunnel;
    }

    async closeAll(): Promise<void> {}
}

function installTestDoubles(
    manager: ConnectionManager,
    tunnelManager: StubTunnelManager,
    adapterFactory: AdapterFactory
): void {
    const mutableManager = manager as unknown as {
        tunnelManager: StubTunnelManager;
        createAdapter: AdapterFactory;
    };

    mutableManager.tunnelManager = tunnelManager;
    mutableManager.createAdapter = adapterFactory;
}

function transientError(): Error {
    const error = new Error('stale SSH local forwarding endpoint');
    Object.assign(error, { code: 'ECONNRESET' });
    return error;
}

function syntaxError(): Error {
    const error = new Error('syntax error at or near "FROM"');
    Object.assign(error, { code: '42601' });
    return error;
}

function resultForPort(port: number): QueryResultData {
    return {
        rows: [{ port }],
        rowCount: 1,
        fields: ['port'],
    };
}

test('rebuilds a lazy SSH adapter with the recovered tunnel endpoint before retrying', async () => {
    const manager = new ConnectionManager();
    const tunnelManager = new StubTunnelManager(tunnelInfo(3307), tunnelInfo(3308));
    const createdPorts: number[] = [];
    const closedPorts: number[] = [];

    installTestDoubles(manager, tunnelManager, (_config, tunnel) => {
        assert.ok(tunnel);
        const port = tunnel.localPort;
        createdPorts.push(port);

        return {
            type: 'mysql',
            async execute() {
                if (port === 3307) {
                    throw transientError();
                }
                return resultForPort(port);
            },
            async listDatabases() {
                return ['app'];
            },
            async listTables() {
                return [];
            },
            async describeTable() {
                return [];
            },
            async close() {
                closedPorts.push(port);
            },
        };
    });

    await manager.initialize([lazySshConfig()]);
    const connection = manager.getAllConnections()[0];

    const result = await connection.adapter.execute('SELECT 1 AS ping', 'app');

    assert.deepEqual(result, resultForPort(3308));
    assert.deepEqual(createdPorts, [3307, 3308]);
    assert.deepEqual(closedPorts, [3307]);
    assert.equal(tunnelManager.ensureCalls, 1);
    assert.equal(tunnelManager.reconnectCalls, 1);
});

test('still retries lazy SSH recovery when closing the stale adapter fails', async () => {
    const manager = new ConnectionManager();
    const tunnelManager = new StubTunnelManager(tunnelInfo(3307), tunnelInfo(3308));
    const closedPorts: number[] = [];

    installTestDoubles(manager, tunnelManager, (_config, tunnel) => {
        assert.ok(tunnel);
        const port = tunnel.localPort;

        return {
            type: 'mysql',
            async execute() {
                if (port === 3307) {
                    throw transientError();
                }
                return resultForPort(port);
            },
            async listDatabases() {
                return ['app'];
            },
            async listTables() {
                return [];
            },
            async describeTable() {
                return [];
            },
            async close() {
                closedPorts.push(port);
                throw new Error('adapter close failed');
            },
        };
    });

    await manager.initialize([lazySshConfig()]);
    const connection = manager.getAllConnections()[0];

    const result = await connection.adapter.execute('SELECT 1 AS ping', 'app');

    assert.deepEqual(result, resultForPort(3308));
    assert.deepEqual(closedPorts, [3307]);
    assert.equal(tunnelManager.reconnectCalls, 1);
});

test('does not recover lazy SSH adapters for non-transient SQL errors', async () => {
    const manager = new ConnectionManager();
    const tunnelManager = new StubTunnelManager(tunnelInfo(3307), tunnelInfo(3308));
    const createdPorts: number[] = [];
    const closedPorts: number[] = [];

    installTestDoubles(manager, tunnelManager, (_config, tunnel) => {
        assert.ok(tunnel);
        const port = tunnel.localPort;
        createdPorts.push(port);

        return {
            type: 'mysql',
            async execute() {
                throw syntaxError();
            },
            async listDatabases() {
                return ['app'];
            },
            async listTables() {
                return [];
            },
            async describeTable() {
                return [];
            },
            async close() {
                closedPorts.push(port);
            },
        };
    });

    await manager.initialize([lazySshConfig()]);
    const connection = manager.getAllConnections()[0];

    await assert.rejects(
        () => connection.adapter.execute('SELECT FROM', 'app'),
        /syntax error/
    );

    assert.deepEqual(createdPorts, [3307]);
    assert.deepEqual(closedPorts, []);
    assert.equal(tunnelManager.reconnectCalls, 0);
});
