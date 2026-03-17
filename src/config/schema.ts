import { z } from 'zod';

/**
 * Jump host configuration for multihop SSH
 */
export const JumpHostConfigSchema = z.object({
    host: z.string().min(1),
    port: z.number().int().positive().default(22),
    username: z.string().min(1),
    password: z.string().optional(),
    privateKey: z.string().optional(),  // Path to private key file
    passphrase: z.string().optional(),  // For encrypted keys
});

/**
 * SSH tunnel configuration schema
 */
export const SSHConfigSchema = z.object({
    enabled: z.boolean(),
    lazy: z.boolean().default(false),   // If true, connect on first query
    host: z.string().min(1),
    port: z.number().int().positive().default(22),
    username: z.string().min(1),
    password: z.string().optional(),
    privateKey: z.string().optional(),  // Path to private key file
    passphrase: z.string().optional(),  // For encrypted keys
    targetHost: z.string().min(1),      // Database host from SSH server's perspective
    targetPort: z.number().int().positive(),
    jumpHosts: z.array(JumpHostConfigSchema).optional(),
});

/**
 * Schema for a single database connection configuration
 */
export const DatabaseConfigSchema = z.object({
    // Unique identifier for tool generation (e.g., "helsia" → execute_sql_helsia)
    id: z
        .string()
        .regex(/^[a-z0-9_]+$/, 'ID must be lowercase alphanumeric with underscores'),

    type: z.enum(['mysql', 'postgresql']),
    host: z.string().min(1),
    port: z.number().int().positive(),
    username: z.string().min(1),
    password: z.string(),

    // "*" means discover all accessible databases, or specify list
    databases: z.union([z.literal('*'), z.array(z.string().min(1)).min(1)]),

    // Optional SSH tunnel configuration
    ssh: SSHConfigSchema.optional(),

    // Optional connection pool settings
    connectionLimit: z.number().int().positive().default(10),
    connectTimeout: z.number().int().positive().default(30000),
    queryTimeout: z.number().int().positive().default(60000),
});

/**
 * Security configuration schema
 */
export const SecurityConfigSchema = z.object({
    // Block DROP, TRUNCATE, ALTER, etc. by default
    blockDangerousQueries: z.boolean().default(true),
    // Patterns for dangerous queries
    dangerousPatterns: z
        .array(z.string())
        .default(['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE']),
});

/**
 * Server configuration schema
 */
export const ServerOptionsSchema = z.object({
    name: z.string().default('db-access'),
    version: z.string().default('1.0.0'),
    resultRowLimit: z.number().int().positive().default(1000),
});

/**
 * Root configuration schema
 */
export const ServerConfigSchema = z.object({
    connections: z.array(DatabaseConfigSchema).min(1),
    server: ServerOptionsSchema.default({}),
    security: SecurityConfigSchema.default({}),
});

// Type exports
export type JumpHostConfig = z.infer<typeof JumpHostConfigSchema>;
export type SSHConfig = z.infer<typeof SSHConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type ServerOptions = z.infer<typeof ServerOptionsSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
