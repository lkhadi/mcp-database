import type { DatabaseType } from '../db/types.js';

/**
 * Return executable text, replacing comments with spaces and quoted tokens with
 * placeholders. This is a lexical guard, not a SQL parser or privilege boundary.
 * Check both string escape modes because callers can change session settings.
 */
export function sqlCodeVariants(sql: string, dialect: DatabaseType): string[] {
    return [...new Set([scan(sql, dialect, false), scan(sql, dialect, true)])];
}

/** Enforce the adapters' one-statement contract independently of keyword policy. */
export function assertSingleStatement(sql: string, dialect: DatabaseType): void {
    for (const code of sqlCodeVariants(sql, dialect)) {
        if (code.split(';').filter((part) => part.trim().length > 0).length !== 1) {
            throw new Error('Exactly one SQL statement is required per call.');
        }
    }
}

function scan(sql: string, dialect: DatabaseType, backslashEscapes: boolean): string {
    const code: string[] = [];
    let i = 0;
    while (i < sql.length) {
        const char = sql[i];
        const next = sql[i + 1];
        const lineComment = char === '-' && next === '-' &&
            (dialect === 'postgresql' || i + 2 === sql.length || /[\x00-\x20]/.test(sql[i + 2]));
        if (lineComment || (dialect === 'mysql' && char === '#')) {
            while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
            code.push(' ');
            continue;
        }
        if (char === '/' && next === '*') {
            if (dialect === 'mysql' && /^\/\*(?:!|M!)/i.test(sql.slice(i, i + 4))) {
                throw new Error('Executable SQL comments are not supported.');
            }
            i += 2;
            let depth = 1;
            while (i < sql.length && depth > 0) {
                if (sql[i] === '*' && sql[i + 1] === '/') {
                    depth--;
                    i += 2;
                } else if (dialect === 'postgresql' && sql[i] === '/' && sql[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else {
                    i++;
                }
            }
            if (depth > 0) throw new Error('Unterminated SQL comment.');
            code.push(' ');
            continue;
        }
        if (dialect === 'postgresql' && char === '$' &&
            (i === 0 || !/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i - 1]))) {
            // PostgreSQL accepts non-ASCII bytes in identifiers, including
            // symbols that Unicode letter/number character classes omit.
            const delimiter = sql.slice(i).match(/^\$(?:[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)?\$/)?.[0];
            if (delimiter) {
                const end = sql.indexOf(delimiter, i + delimiter.length);
                if (end < 0) throw new Error('Unterminated dollar-quoted SQL string.');
                i = end + delimiter.length;
                code.push(' ? ');
                continue;
            }
        }
        if (char === "'" || char === '"' || (dialect === 'mysql' && char === '`')) {
            const escapeString = dialect === 'postgresql' && char === "'" &&
                /e/i.test(sql[i - 1] ?? '') &&
                (i < 2 || !/[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i - 2]));
            const escapes = char !== '`' && (char === "'" || dialect === 'mysql') &&
                (escapeString || backslashEscapes);
            i++;
            let closed = false;
            while (i < sql.length) {
                if (escapes && sql[i] === '\\') {
                    i += 2;
                } else if (sql[i] === char) {
                    i++;
                    if (sql[i] === char) i++;
                    else { closed = true; break; }
                } else {
                    i++;
                }
            }
            if (!closed) throw new Error('Unterminated or ambiguous SQL quote; use doubled quotes for escaping.');
            code.push(' ? ');
            continue;
        }
        code.push(char);
        i++;
    }
    return code.join('');
}
