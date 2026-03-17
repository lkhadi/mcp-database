import type { QueryResultData, ColumnInfo } from '../db/types.js';

/**
 * Format query results for LLM-friendly output
 */
export function formatQueryResult(result: QueryResultData, maxRows: number = 1000): string {
    // Handle non-SELECT results
    if (result.rows.length === 0 && result.affectedRows !== undefined) {
        return `Query executed successfully. Affected rows: ${result.affectedRows}`;
    }

    if (result.rows.length === 0) {
        return 'No rows returned.';
    }

    // Truncate if needed
    const rows = result.rows.slice(0, maxRows);
    const truncated = result.rows.length > maxRows;

    // Calculate column widths
    const widths: Record<string, number> = {};
    for (const field of result.fields) {
        widths[field] = field.length;
    }

    for (const row of rows) {
        for (const field of result.fields) {
            const value = formatValue(row[field]);
            widths[field] = Math.max(widths[field], value.length);
        }
    }

    // Build table
    const lines: string[] = [];

    // Header
    const header = result.fields.map((f) => f.padEnd(widths[f])).join(' | ');
    lines.push(header);
    lines.push(result.fields.map((f) => '-'.repeat(widths[f])).join('-+-'));

    // Rows
    for (const row of rows) {
        const rowLine = result.fields.map((f) => formatValue(row[f]).padEnd(widths[f])).join(' | ');
        lines.push(rowLine);
    }

    // Footer
    lines.push('');
    lines.push(`Rows: ${rows.length}${truncated ? ` (truncated from ${result.rows.length})` : ''}`);

    return lines.join('\n');
}

/**
 * Format a single value for display
 */
function formatValue(value: unknown): string {
    if (value === null) return 'NULL';
    if (value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * Format column info for display
 */
export function formatColumnInfo(columns: ColumnInfo[]): string {
    if (columns.length === 0) {
        return 'No columns found.';
    }

    const lines: string[] = [];
    lines.push('| Column | Type | Nullable | Default | Key |');
    lines.push('|--------|------|----------|---------|-----|');

    for (const col of columns) {
        const nullable = col.nullable ? 'YES' : 'NO';
        const defaultVal = col.defaultValue ?? '';
        const key = col.isPrimaryKey ? 'PRI' : '';
        lines.push(`| ${col.name} | ${col.type} | ${nullable} | ${defaultVal} | ${key} |`);
    }

    return lines.join('\n');
}

/**
 * Format table list for display
 */
export function formatTableList(tables: string[], database: string): string {
    if (tables.length === 0) {
        return `No tables found in database: ${database}`;
    }

    const lines: string[] = [];
    lines.push(`Tables in ${database}:`);
    lines.push('');
    for (const table of tables) {
        lines.push(`  - ${table}`);
    }
    lines.push('');
    lines.push(`Total: ${tables.length} tables`);

    return lines.join('\n');
}

/**
 * Format database list for display
 */
export function formatDatabaseList(
    connections: Array<{ id: string; type: string; databases: string[] }>
): string {
    const lines: string[] = [];
    lines.push('Available database connections:');
    lines.push('');

    for (const conn of connections) {
        lines.push(`[${conn.id}] (${conn.type})`);
        for (const db of conn.databases) {
            lines.push(`  - ${db}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
