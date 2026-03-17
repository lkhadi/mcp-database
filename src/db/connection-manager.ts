import type { DatabaseConfig } from '../config/schema.js';
import type { DatabaseAdapter, PoolOptions } from './types.js';
import { MySQLAdapter } from './mysql-adapter.js';
import { PostgreSQLAdapter } from './postgresql-adapter.js';
import { SSHTunnelManager, TunnelInfo } from '../ssh/tunnel-manager.js';

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
    private tunnelManager: SSHTunnelManager = new SSHTunnelManager();

    /**
     * Initialize connections from configuration
     */
    async initialize(configs: DatabaseConfig[]): Promise<void> {
        for (const config of configs) {
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
                    continue;
                }
            }

            await this.initializeConnection(config, tunnelInfo);
        }
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
                throw error;
            }
        } else {
            databases = config.databases;
        }

        if (databases.length === 0) {
            console.error(`[${config.id}] Warning: No databases found for connection`);
        }

        this.connections.set(config.id, {
            id: config.id,
            type: config.type,
            adapter,
            databases,
            tunnelInfo: tunnelInfo ?? undefined,
        });
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
        // Check if connection is already established
        const existing = this.connections.get(id);
        if (existing) {
            return existing;
        }

        // Check if this is a pending lazy connection
        const lazy = this.lazyConnections.get(id);
        if (lazy) {
            console.error(`[${id}] Establishing lazy SSH tunnel...`);
            const tunnelInfo = await this.tunnelManager.ensureConnected(id);
            await this.initializeConnection(lazy.config, tunnelInfo);
            this.lazyConnections.delete(id); // Remove from lazy, now it's active
            return this.connections.get(id);
        }

        return undefined;
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
                adapter: this.createLazyAdapter(lazy),
                databases: lazy.databases,
                isLazySSH: true,
            });
        }

        return resolved;
    }

    /**
     * Create a lazy adapter that connects on first use
     */
    private createLazyAdapter(lazy: LazyConnection): DatabaseAdapter {
        const manager = this;
        const lazyId = lazy.id;

        // Create a proxy adapter that establishes connection on first use
        const lazyAdapter: DatabaseAdapter = {
            type: lazy.type,

            async execute(sql: string, database?: string) {
                const conn = await manager.getConnectionAsync(lazyId);
                if (!conn) throw new Error(`Failed to establish lazy connection: ${lazyId}`);
                return conn.adapter.execute(sql, database);
            },

            async listDatabases() {
                const conn = await manager.getConnectionAsync(lazyId);
                if (!conn) throw new Error(`Failed to establish lazy connection: ${lazyId}`);
                return conn.adapter.listDatabases();
            },

            async listTables(database: string) {
                const conn = await manager.getConnectionAsync(lazyId);
                if (!conn) throw new Error(`Failed to establish lazy connection: ${lazyId}`);
                return conn.adapter.listTables(database);
            },

            async describeTable(database: string, table: string) {
                const conn = await manager.getConnectionAsync(lazyId);
                if (!conn) throw new Error(`Failed to establish lazy connection: ${lazyId}`);
                return conn.adapter.describeTable(database, table);
            },

            async close() {
                // Nothing to close for lazy adapter
            },
        };

        return lazyAdapter;
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
        const closePromises = Array.from(this.connections.values()).map((conn) =>
            conn.adapter.close()
        );
        await Promise.all(closePromises);
        this.connections.clear();
        this.lazyConnections.clear();

        // Then close SSH tunnels
        await this.tunnelManager.closeAll();

        console.error('Shutdown complete');
    }
}
