import { MySQLAdapter } from '../../src/db/mysql-adapter.js';
import { PostgreSQLAdapter } from '../../src/db/postgresql-adapter.js';
import type { DatabaseType } from '../../src/db/types.js';

export function stubDriver(type: DatabaseType, query: (sql: string) => Promise<unknown>, acquire?: () => Promise<void>) {
    const options = { host: 'unused.invalid', port: 1, user: 'test', password: 'fake' };
    const adapter = type === 'mysql' ? new MySQLAdapter(options) : new PostgreSQLAdapter(options);
    let ended = 0;
    let released = 0;
    const client = { query, release() { released++; } };
    const pool = {
        async getConnection() { await acquire?.(); return client; },
        async connect() { await acquire?.(); return client; },
        async end() { ended++; },
    };
    const mutable = adapter as unknown as { getPool: () => typeof pool; pools: Map<string, typeof pool> };
    mutable.getPool = () => { mutable.pools.set('app', pool); return pool; };
    return { adapter, get ended() { return ended; }, get released() { return released; } };
}

export function writeResult(type: DatabaseType) {
    return type === 'mysql' ? [{ affectedRows: 1 }, []] : { rows: [], fields: [], rowCount: 1 };
}

export function connectionLost() {
    return Object.assign(new Error('response lost'), { code: 'ECONNRESET' });
}
