import type { DatabaseType } from '../db/types.js';
import { sqlCodeVariants } from './sql-lexer.js';

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
    validate(sql: string, dialect: DatabaseType = 'mysql'): ValidationResult {
        if (!this.enabled) {
            return { valid: true };
        }

        let cleanedSql: string;
        try {
            cleanedSql = sqlCodeVariants(sql, dialect).join('\n');
        } catch (error) {
            return { valid: false, reason: error instanceof Error ? error.message : String(error) };
        }

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

}
