import pg from 'pg';
import type { DatabaseAdapter, QueryResultData, ColumnInfo, PoolOptions } from './types.js';

const { Pool } = pg;

/**
 * PostgreSQL database adapter
 */
export class PostgreSQLAdapter implements DatabaseAdapter {
    readonly type = 'postgresql' as const;
    private pools: Map<string, pg.Pool> = new Map();
    private options: PoolOptions;
    private queryTimeout: number;

    constructor(options: PoolOptions, queryTimeout: number = 60000) {
        this.options = options;
        this.queryTimeout = queryTimeout;
    }

    /**
     * Get or create a connection pool for a specific database
     */
    private getPool(database: string): pg.Pool {
        const key = database;
        let pool = this.pools.get(key);

        if (!pool) {
            pool = new Pool({
                host: this.options.host,
                port: this.options.port,
                user: this.options.user,
                password: this.options.password,
                database: database,
                max: this.options.connectionLimit ?? 10,
                connectionTimeoutMillis: this.options.connectTimeout ?? 30000,
                idleTimeoutMillis: 30000,
            });
            this.pools.set(key, pool);
        }

        return pool;
    }

    async execute(sql: string, database?: string): Promise<QueryResultData> {
        const db = database ?? this.options.database;
        if (!db) {
            throw new Error('No database specified');
        }

        const pool = this.getPool(db);
        const client = await pool.connect();

        try {
            // Set query timeout
            await client.query(`SET statement_timeout = ${this.queryTimeout}`);

            const result = await client.query(sql);

            // Handle non-SELECT queries
            if (!result.rows || result.rows.length === 0) {
                return {
                    rows: [],
                    rowCount: 0,
                    fields: result.fields?.map((f) => f.name) ?? [],
                    affectedRows: result.rowCount ?? 0,
                };
            }

            return {
                rows: result.rows as Record<string, unknown>[],
                rowCount: result.rows.length,
                fields: result.fields.map((f) => f.name),
            };
        } finally {
            client.release();
        }
    }

    async listDatabases(): Promise<string[]> {
        // Use a default connection to postgres database to list all databases
        const pool = new Pool({
            host: this.options.host,
            port: this.options.port,
            user: this.options.user,
            password: this.options.password,
            database: 'postgres',
            max: 1,
        });

        try {
            const result = await pool.query(`
        SELECT datname FROM pg_database 
        WHERE datistemplate = false 
        AND datname NOT IN ('postgres')
        ORDER BY datname
      `);
            return result.rows.map((row) => row.datname as string);
        } finally {
            await pool.end();
        }
    }

    async listTables(database: string): Promise<string[]> {
        const pool = this.getPool(database);
        const result = await pool.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
        return result.rows.map((row) => row.tablename as string);
    }

    async describeTable(database: string, table: string): Promise<ColumnInfo[]> {
        const pool = this.getPool(database);
        const result = await pool.query(
            `
      SELECT 
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT ku.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage ku
          ON tc.constraint_name = ku.constraint_name
        WHERE tc.table_name = $1
          AND tc.constraint_type = 'PRIMARY KEY'
      ) pk ON c.column_name = pk.column_name
      WHERE c.table_name = $1
        AND c.table_schema = 'public'
      ORDER BY c.ordinal_position
    `,
            [table]
        );

        return result.rows.map((row) => ({
            name: row.column_name as string,
            type: row.data_type as string,
            nullable: row.is_nullable === 'YES',
            defaultValue: row.column_default as string | null,
            isPrimaryKey: row.is_primary_key as boolean,
        }));
    }

    async close(): Promise<void> {
        const closePromises = Array.from(this.pools.values()).map((pool) => pool.end());
        await Promise.all(closePromises);
        this.pools.clear();
    }
}
