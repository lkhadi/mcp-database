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

function transientError(): Error {
    const error = new Error('stale SSH local forwarding endpoint');
    Object.assign(error, { code: 'ECONNRESET' });
    return error;
}

/** Mirrors the real failure: jump host reachable, forwarded channel times out. */
function tunnelDownError(): Error {
    return new Error(
        'Failed to forward through 103.197.190.111: (SSH) Channel open failure: Connection timed out'
    );
}

function resultForPort(port: number): QueryResultData {
    return { rows: [{ port }], rowCount: 1, fields: ['port'] };
}

/** Tunnel that refuses to reconnect N times, then comes back on a new local port. */
class FlakyTunnelManager {
    ensureCalls = 0;
    reconnectCalls = 0;

    constructor(
        private readonly initialTunnel: TunnelInfo,
        private readonly recoveredTunnel: TunnelInfo,
        private readonly failedReconnects: number
    ) {}

    async register(): Promise<TunnelInfo | null> {
        return null;
    }

    /** Opening a fresh tunnel always works; only in-place reconnects are flaky. */
    async ensureConnected(): Promise<TunnelInfo> {
        this.ensureCalls++;
        return this.reconnectCalls > 0 ? this.recoveredTunnel : this.initialTunnel;
    }

    async reconnect(): Promise<TunnelInfo> {
        this.reconnectCalls++;
        if (this.reconnectCalls <= this.failedReconnects) {
            throw tunnelDownError();
        }
        return this.recoveredTunnel;
    }

    async closeAll(): Promise<void> {}
}

function installTestDoubles(
    manager: ConnectionManager,
    tunnelManager: FlakyTunnelManager,
    adapterFactory: AdapterFactory
): void {
    const mutableManager = manager as unknown as {
        tunnelManager: FlakyTunnelManager;
        createAdapter: AdapterFactory;
    };

    mutableManager.tunnelManager = tunnelManager;
    mutableManager.createAdapter = adapterFactory;
}

test('recovers on a later call after the SSH tunnel reconnect fails once', async () => {
    const manager = new ConnectionManager();
    // First reconnect attempt fails (tunnel genuinely down), the next one succeeds.
    const tunnelManager = new FlakyTunnelManager(tunnelInfo(3307), tunnelInfo(3309), 1);

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
            async close() {},
        };
    });

    await manager.initialize([lazySshConfig()]);
    const connection = manager.getAllConnections()[0];

    // 1st call: adapter hits a transient error, recovery runs, tunnel reconnect fails.
    // Surfacing the tunnel error here is correct.
    await assert.rejects(
        () => connection.adapter.execute('SELECT 1 AS ping', 'app'),
        /Channel open failure/
    );

    // 2nd call: the tunnel is healthy again. The connection MUST rebuild itself.
    // Today it throws "Failed to establish connection: ssh_mysql" forever until restart.
    const result = await connection.adapter.execute('SELECT 1 AS ping', 'app');
    assert.deepEqual(result, resultForPort(3309));
});

test('does not wedge a connection when the SSH tunnel reconnect fails', async () => {
    const manager = new ConnectionManager();
    const tunnelManager = new FlakyTunnelManager(tunnelInfo(3307), tunnelInfo(3309), 1);

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
            async close() {},
        };
    });

    await manager.initialize([lazySshConfig()]);
    const connection = manager.getAllConnections()[0];

    await assert.rejects(() => connection.adapter.execute('SELECT 1 AS ping', 'app'));

    // The production symptom: every later call failed instantly with
    // "Failed to establish connection: <id>" until the server was restarted.
    await assert.doesNotReject(
        () => connection.adapter.execute('SELECT 1 AS ping', 'app'),
        /Failed to establish connection/
    );
});

test('keeps a connection usable when it is unreachable at startup', async () => {
    const manager = new ConnectionManager();
    const tunnelManager = new FlakyTunnelManager(tunnelInfo(3307), tunnelInfo(3307), 0);
    let discoveryAttempts = 0;

    installTestDoubles(manager, tunnelManager, (config, tunnel) => {
        // A direct (non-SSH) connection is built without tunnel info.
        const port = tunnel?.localPort ?? config.port;

        return {
            type: 'mysql',
            async execute() {
                return resultForPort(port);
            },
            async listDatabases() {
                discoveryAttempts++;
                if (discoveryAttempts === 1) {
                    throw transientError();
                }
                return ['app'];
            },
            async listTables() {
                return [];
            },
            async describeTable() {
                return [];
            },
            async close() {},
        };
    });

    const config: DatabaseConfig = {
        ...lazySshConfig(),
        id: 'direct_mysql',
        databases: '*',
        ssh: undefined,
    };
    await manager.initialize([config]);

    // Startup discovery failed, but the server is still up and the connection listed.
    const connection = manager.getAllConnections()[0];
    assert.equal(connection.id, 'direct_mysql');

    // ...and it establishes itself on first use instead of needing a restart.
    const result = await connection.adapter.execute('SELECT 1 AS ping', 'app');
    assert.deepEqual(result, resultForPort(3306));
});
