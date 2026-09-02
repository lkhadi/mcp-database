import type { DatabaseConfig } from '../config/schema.js';
import type { DatabaseAdapter, PoolOptions } from './types.js';
import { MySQLAdapter } from './mysql-adapter.js';
import { PostgreSQLAdapter } from './postgresql-adapter.js';
import { SSHTunnelManager, TunnelInfo } from '../ssh/tunnel-manager.js';
import { isTransientConnectionError } from './connection-retry.js';

/**
 * Resolved database connection with adapter and available databases
 */
export interface ResolvedConnection {
    id: string;
    type: 'mysql' | 'postgresql';
    adapter: DatabaseAdapter;
    databases: string[];
    tunnelInfo?: TunnelInfo;
    isLazySSH?: boolean;
}

/**
 * Lazy connection placeholder - has databases but adapter will be created on first use
 */
interface LazyConnection {
    id: string;
    type: 'mysql' | 'postgresql';
    config: DatabaseConfig;
    databases: string[];
}

/**
 * Connection manager - handles creating and managing database adapters
 * with optional SSH tunnel support
 */
export class ConnectionManager {
    private connections: Map<string, ResolvedConnection> = new Map();
    private lazyConnections: Map<string, LazyConnection> = new Map();
    private connectionConfigs: Map<string, DatabaseConfig> = new Map();
    private activeAdapters: Map<string, DatabaseAdapter> = new Map();
    private managedAdapters: Map<string, DatabaseAdapter> = new Map();
    private tunnelManager: SSHTunnelManager = new SSHTunnelManager();

    /**
     * Initialize connections from configuration
     */
    async initialize(configs: DatabaseConfig[]): Promise<void> {
        for (const config of configs) {
            this.connectionConfigs.set(config.id, config);

            try {
                await this.initializeFromConfig(config);
            } catch (error) {
                this.registerUnreachableConnection(config, error);
            }
        }
    }

    /**
     * Establish a single connection from its configuration
     */
    private async initializeFromConfig(config: DatabaseConfig): Promise<void> {
        // Handle SSH tunnel if configured
        let tunnelInfo: TunnelInfo | null = null;

        if (config.ssh?.enabled) {
            tunnelInfo = await this.tunnelManager.register(config.id, config.ssh);

            // If lazy SSH, register as lazy connection (tools will be generated but connection deferred)
            if (config.ssh.lazy && !tunnelInfo) {
                console.error(`[${config.id}] SSH tunnel registered (lazy mode - will connect on first use)`);

                // Store as lazy connection with databases from config
                const databases = config.databases === '*' ? [] : config.databases;

                if (databases.length === 0 && config.databases === '*') {
                    console.error(`[${config.id}] Warning: Cannot discover databases in lazy mode. Please specify database list explicitly.`);
                }

                this.lazyConnections.set(config.id, {
                    id: config.id,
                    type: config.type,
                    config,
                    databases,
                });
                return;
            }
        }

        await this.initializeConnection(config, tunnelInfo);
    }

    /**
     * Keep a connection that is unreachable at startup out of the fatal path.
     * One database being down must not take the whole MCP server with it; the
     * connection is registered and re-established on first use instead.
     */
    private registerUnreachableConnection(config: DatabaseConfig, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${config.id}] Unreachable at startup, will retry on first use: ${message}`);

        if (config.databases === '*') {
            console.error(
                `[${config.id}] Warning: databases is "*" and discovery failed, so no databases can be listed for it. Configure an explicit database list to keep this connection usable while the server is down.`
            );
        }

        this.connections.set(config.id, {
            id: config.id,
            type: config.type,
            adapter: this.createManagedAdapter(config.id, config.type),
            databases: config.databases === '*' ? [] : config.databases,
        });
    }

    /**
     * Initialize a single connection with optional tunnel info
     */
    private async initializeConnection(config: DatabaseConfig, tunnelInfo: TunnelInfo | null): Promise<void> {
        const adapter = this.createAdapter(config, tunnelInfo);

        // Resolve databases (discover if wildcard)
        let databases: string[];
        if (config.databases === '*') {
            try {
                databases = await adapter.listDatabases();
                console.error(
                    `[${config.id}] Discovered ${databases.length} databases: ${databases.join(', ')}`
                );
            } catch (error) {
                console.error(`[${config.id}] Failed to discover databases:`, error);
                await this.closeAdapter(config.id, adapter);
                throw error;
            }
        } else {
            databases = config.databases;
        }

        if (databases.length === 0) {
            console.error(`[${config.id}] Warning: No databases found for connection`);
        }

        // Publish the live adapter and the resolved connection together. Leaving
        // a connection registered without its adapter makes it permanently
        // unusable, and only a server restart can clear that.
        await this.closeActiveAdapter(config.id);
        this.activeAdapters.set(config.id, adapter);
        this.connections.set(config.id, {
            id: config.id,
            type: config.type,
            adapter: this.createManagedAdapter(config.id, config.type),
            databases,
            tunnelInfo: tunnelInfo ?? undefined,
        });
        this.lazyConnections.delete(config.id);
    }

    /**
     * Create appropriate adapter based on database type
     * Uses tunnel endpoint if SSH is configured
     */
    private createAdapter(config: DatabaseConfig, tunnelInfo: TunnelInfo | null): DatabaseAdapter {
        // If tunnel is active, use tunnel endpoint instead of direct connection
        const host = tunnelInfo ? tunnelInfo.localHost : config.host;
        const port = tunnelInfo ? tunnelInfo.localPort : config.port;

        const poolOptions: PoolOptions = {
            host,
            port,
            user: config.username,
            password: config.password,
            connectionLimit: config.connectionLimit,
            connectTimeout: config.connectTimeout,
        };

        switch (config.type) {
            case 'mysql':
                return new MySQLAdapter(poolOptions, config.queryTimeout);
            case 'postgresql':
                return new PostgreSQLAdapter(poolOptions, config.queryTimeout);
            default:
                throw new Error(`Unsupported database type: ${config.type}`);
        }
    }

    /**
     * Get a resolved connection by ID
     * For lazy SSH connections, this will trigger tunnel establishment
     */
    async getConnectionAsync(id: string): Promise<ResolvedConnection | undefined> {
        // `connections` records what is configured and listable, `activeAdapters`
        // records what is actually live. A failed recovery leaves the first
        // without the second, so reconcile them here rather than assuming a
        // listed connection is a working one.
        const existing = this.connections.get(id);
        if (existing && this.activeAdapters.has(id)) {
            return existing;
        }

        const config = this.lazyConnections.get(id)?.config ?? this.connectionConfigs.get(id);
        if (!config) {
            return existing;
        }

        if (this.lazyConnections.has(id)) {
            console.error(`[${id}] Establishing lazy SSH tunnel...`);
        } else if (existing) {
            console.error(`[${id}] Connection has no live adapter, re-establishing...`);
        }

        const tunnelInfo = config.ssh?.enabled
            ? await this.tunnelManager.ensureConnected(id)
            : null;

        await this.initializeConnection(config, tunnelInfo);
        return this.connections.get(id);
    }

    /**
     * Get a resolved connection by ID (sync version for non-lazy connections)
     */
    getConnection(id: string): ResolvedConnection | undefined {
        return this.connections.get(id);
    }

    /**
     * Get all resolved connections (includes placeholder for lazy connections for tool generation)
     */
    getAllConnections(): ResolvedConnection[] {
        const resolved = Array.from(this.connections.values());

        // Include lazy connections as placeholders for tool registration
        for (const lazy of this.lazyConnections.values()) {
            resolved.push({
                id: lazy.id,
                type: lazy.type,
                adapter: this.createManagedAdapter(lazy.id, lazy.type),
                databases: lazy.databases,
                isLazySSH: true,
            });
        }

        return resolved;
    }

    /**
     * Create a manager-owned adapter proxy that can recover SSH-backed connections.
     */
    private createManagedAdapter(id: string, type: 'mysql' | 'postgresql'): DatabaseAdapter {
        const key = `${id}:${type}`;
        const existing = this.managedAdapters.get(key);
        if (existing) {
            return existing;
        }

        const adapter: DatabaseAdapter = {
            type,

            execute: (sql: string, database?: string) =>
                this.withManagedAdapter(id, (activeAdapter) => activeAdapter.execute(sql, database)),

            listDatabases: () =>
                this.withManagedAdapter(id, (activeAdapter) => activeAdapter.listDatabases()),

            listTables: (database: string) =>
                this.withManagedAdapter(id, (activeAdapter) => activeAdapter.listTables(database)),

            describeTable: (database: string, table: string) =>
                this.withManagedAdapter(id, (activeAdapter) => activeAdapter.describeTable(database, table)),

            close: () => this.closeActiveAdapter(id),
        };

        this.managedAdapters.set(`${id}:${type}`, adapter);
        return adapter;
    }

    private async withManagedAdapter<T>(
        id: string,
        operation: (adapter: DatabaseAdapter) => Promise<T>
    ): Promise<T> {
        await this.getConnectionAsync(id);

        const adapter = this.activeAdapters.get(id);
        if (!adapter) {
            throw new Error(`Failed to establish connection: ${id}`);
        }

        try {
            return await operation(adapter);
        } catch (error) {
            if (!this.shouldRecoverSshConnection(id, error)) {
                throw error;
            }

            await this.recoverSshConnection(id);

            const recoveredAdapter = this.activeAdapters.get(id);
            if (!recoveredAdapter) {
                throw new Error(`Failed to recover SSH connection: ${id}`);
            }

            return operation(recoveredAdapter);
        }
    }

    private shouldRecoverSshConnection(id: string, error: unknown): boolean {
        const config = this.connectionConfigs.get(id) ?? this.lazyConnections.get(id)?.config;
        const resolved = this.connections.get(id);
        return Boolean(config?.ssh?.enabled && resolved?.tunnelInfo && isTransientConnectionError(error));
    }

    private async recoverSshConnection(id: string): Promise<void> {
        const config = this.connectionConfigs.get(id) ?? this.lazyConnections.get(id)?.config;
        if (!config) {
            throw new Error(`No configuration found for connection: ${id}`);
        }

        await this.closeActiveAdapter(id);

        // Reuse databases we already resolved so recovery does not pay for
        // another discovery round trip over a freshly rebuilt tunnel.
        const knownDatabases = this.connections.get(id)?.databases;
        const recoveryConfig: DatabaseConfig =
            config.databases === '*' && knownDatabases && knownDatabases.length > 0
                ? { ...config, databases: knownDatabases }
                : config;

        const tunnelInfo = await this.tunnelManager.reconnect(id);
        await this.initializeConnection(recoveryConfig, tunnelInfo);
    }

    private async closeActiveAdapter(id: string): Promise<void> {
        const adapter = this.activeAdapters.get(id);
        if (!adapter) {
            return;
        }

        this.activeAdapters.delete(id);
        await this.closeAdapter(id, adapter);
    }

    /**
     * Close an adapter without letting cleanup failures mask the original error.
     */
    private async closeAdapter(id: string, adapter: DatabaseAdapter): Promise<void> {
        try {
            await adapter.close();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${id}] Failed to close stale database adapter: ${message}`);
        }
    }

    /**
     * Check if a connection has a pending lazy SSH tunnel
     */
    hasPendingLazyConnection(id: string): boolean {
        return this.lazyConnections.has(id);
    }

    /**
     * Close all connections and tunnels
     */
    async closeAll(): Promise<void> {
        // Close database connections first
        console.error('Closing database connections...');
        const closePromises = Array.from(this.activeAdapters.values()).map((adapter) => adapter.close());
        await Promise.all(closePromises);
        this.activeAdapters.clear();
        this.managedAdapters.clear();
        this.connections.clear();
        this.lazyConnections.clear();
        this.connectionConfigs.clear();

        // Then close SSH tunnels
        await this.tunnelManager.closeAll();

        console.error('Shutdown complete');
    }
}
