import type { Pool as MySQLPool, RowDataPacket } from 'mysql2/promise';
import type { Pool as PgPool, QueryResult } from 'pg';

/**
 * Supported database types
 */
export type DatabaseType = 'mysql' | 'postgresql';

/**
 * Union type for connection pools
 */
export type ConnectionPool = MySQLPool | PgPool;

/**
 * Query result structure
 */
export interface QueryResultData {
    rows: Record<string, unknown>[];
    rowCount: number;
    fields: string[];
    affectedRows?: number;
}

/**
 * Database adapter interface - common operations for MySQL and PostgreSQL
 */
export interface DatabaseAdapter {
    readonly type: DatabaseType;

    /**
     * Execute a SQL query
     */
    execute(sql: string, database?: string): Promise<QueryResultData>;

    /**
     * List all accessible databases
     */
    listDatabases(): Promise<string[]>;

    /**
     * List all tables in a database
     */
    listTables(database: string): Promise<string[]>;

    /**
     * Describe a table's columns
     */
    describeTable(database: string, table: string): Promise<ColumnInfo[]>;

    /**
     * Close all connections
     */
    close(): Promise<void>;
}

/**
 * Column information structure
 */
export interface ColumnInfo {
    name: string;
    type: string;
    nullable: boolean;
    defaultValue: string | null;
    isPrimaryKey: boolean;
    extra?: string;
}

/**
 * Connection pool options
 */
export interface PoolOptions {
    host: string;
    port: number;
    user: string;
    password: string;
    database?: string;
    connectionLimit?: number;
    connectTimeout?: number;
}
