import mysql from 'mysql2/promise';
import type { Pool, RowDataPacket, FieldPacket } from 'mysql2/promise';
import type { DatabaseAdapter, QueryResultData, ColumnInfo, PoolOptions } from './types.js';
import { withConnectionRetry } from './connection-retry.js';

/**
 * MySQL database adapter
 */
export class MySQLAdapter implements DatabaseAdapter {
    readonly type = 'mysql' as const;
    private pools: Map<string, Pool> = new Map();
    private options: PoolOptions;
    private queryTimeout: number;

    constructor(options: PoolOptions, queryTimeout: number = 60000) {
        this.options = options;
        this.queryTimeout = queryTimeout;
    }

    /**
     * Get or create a connection pool for a specific database
     */
    private getPool(database: string): Pool {
        const key = database;
        let pool = this.pools.get(key);

        if (!pool) {
            pool = mysql.createPool({
                host: this.options.host,
                port: this.options.port,
                user: this.options.user,
                password: this.options.password,
                database: database,
                connectionLimit: this.options.connectionLimit ?? 10,
                connectTimeout: this.options.connectTimeout ?? 30000,
                waitForConnections: true,
                queueLimit: 0,
            });
            this.pools.set(key, pool);
        }

        return pool;
    }

    private async resetPool(database: string): Promise<void> {
        const pool = this.pools.get(database);
        if (!pool) {
            return;
        }

        try {
            await pool.end();
        } catch {
            // Ignore errors from ending an already-broken pool
        } finally {
            this.pools.delete(database);
        }
    }

    async execute(sql: string, database?: string): Promise<QueryResultData> {
        const db = database ?? this.options.database;
        if (!db) {
            throw new Error('No database specified');
        }

        return withConnectionRetry(
            async () => {
                const pool = this.getPool(db);
                const connection = await pool.getConnection();

                try {
                    // Set query timeout
                    await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${this.queryTimeout}`);

                    const [rows, fields] = await connection.query<RowDataPacket[]>(sql);

                    // Handle non-SELECT queries
                    if (!Array.isArray(rows)) {
                        const result = rows as unknown as mysql.ResultSetHeader;
                        return {
                            rows: [],
                            rowCount: 0,
                            fields: [],
                            affectedRows: result.affectedRows,
                        };
                    }

                    const fieldNames = (fields as FieldPacket[]).map((f) => f.name);

                    return {
                        rows: rows as Record<string, unknown>[],
                        rowCount: rows.length,
                        fields: fieldNames,
                    };
                } finally {
                    connection.release();
                }
            },
            () => this.resetPool(db)
        );
    }

    async listDatabases(): Promise<string[]> {
        return withConnectionRetry(
            async () => {
                // Use a default connection to list databases
                const pool = mysql.createPool({
                    host: this.options.host,
                    port: this.options.port,
                    user: this.options.user,
                    password: this.options.password,
                    connectionLimit: 1,
                });

                try {
                    const [rows] = await pool.query<RowDataPacket[]>('SHOW DATABASES');
                    const systemDbs = ['information_schema', 'mysql', 'performance_schema', 'sys'];
                    return rows
                        .map((row) => row.Database as string)
                        .filter((db) => !systemDbs.includes(db));
                } finally {
                    await pool.end();
                }
            },
            async () => {
                // listDatabases uses a temporary pool; nothing persistent to reset
            }
        );
    }

    async listTables(database: string): Promise<string[]> {
        return withConnectionRetry(
            async () => {
                const pool = this.getPool(database);
                const [rows] = await pool.query<RowDataPacket[]>('SHOW TABLES');

                return rows.map((row) => Object.values(row)[0] as string);
            },
            () => this.resetPool(database)
        );
    }

    async describeTable(database: string, table: string): Promise<ColumnInfo[]> {
        return withConnectionRetry(
            async () => {
                const pool = this.getPool(database);
                const [rows] = await pool.query<RowDataPacket[]>(`DESCRIBE \`${table.replace(/`/g, '``')}\``);

                return rows.map((row) => ({
                    name: row.Field as string,
                    type: row.Type as string,
                    nullable: row.Null === 'YES',
                    defaultValue: row.Default as string | null,
                    isPrimaryKey: row.Key === 'PRI',
                    extra: row.Extra as string,
                }));
            },
            () => this.resetPool(database)
        );
    }

    async close(): Promise<void> {
        const closePromises = Array.from(this.pools.values()).map((pool) => pool.end());
        await Promise.all(closePromises);
        this.pools.clear();
    }
}
