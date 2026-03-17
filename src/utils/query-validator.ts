/**
 * Query validation result
 */
export interface ValidationResult {
    valid: boolean;
    reason?: string;
}

/**
 * Query validator for detecting dangerous SQL patterns
 */
export class QueryValidator {
    private dangerousPatterns: RegExp[];
    private enabled: boolean;

    constructor(patterns: string[], enabled: boolean) {
        this.enabled = enabled;
        // Build regex patterns with word boundaries
        this.dangerousPatterns = patterns.map(
            (p) => new RegExp(`\\b${this.escapeRegex(p)}\\b`, 'i')
        );
    }

    /**
     * Escape special regex characters
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Validate a SQL query
     */
    validate(sql: string): ValidationResult {
        if (!this.enabled) {
            return { valid: true };
        }

        // Remove comments and string literals for safer matching
        const cleanedSql = this.removeStringsAndComments(sql);

        for (const pattern of this.dangerousPatterns) {
            if (pattern.test(cleanedSql)) {
                const match = cleanedSql.match(pattern);
                return {
                    valid: false,
                    reason:
                        `Query contains dangerous keyword: "${match?.[0]}". ` +
                        'This operation is blocked by default. ' +
                        'Set "blockDangerousQueries": false in config to override.',
                };
            }
        }

        return { valid: true };
    }

    /**
     * Remove string literals and comments from SQL for pattern matching
     * This prevents false positives from matching keywords inside strings
     */
    private removeStringsAndComments(sql: string): string {
        // Remove single-line comments
        let result = sql.replace(/--.*$/gm, '');

        // Remove multi-line comments
        result = result.replace(/\/\*[\s\S]*?\*\//g, '');

        // Remove single-quoted strings (replace with placeholder to maintain structure)
        result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");

        // Remove double-quoted strings
        result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');

        return result;
    }
}
