import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { ServerConfigSchema, type ServerConfig } from './schema.js';

/**
 * Load and validate configuration from a JSON file
 */
export function loadConfig(configPath: string): ServerConfig {
    const absolutePath = resolve(configPath);

    if (!existsSync(absolutePath)) {
        throw new Error(`Configuration file not found: ${absolutePath}`);
    }

    let rawConfig: unknown;
    try {
        const fileContent = readFileSync(absolutePath, 'utf-8');
        rawConfig = JSON.parse(fileContent);
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSON in configuration file: ${error.message}`);
        }
        throw error;
    }

    // Validate configuration with Zod
    const result = ServerConfigSchema.safeParse(rawConfig);
    if (!result.success) {
        const issues = result.error.issues
            .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
            .join('\n');
        throw new Error(`Configuration validation failed:\n${issues}`);
    }

    return result.data;
}

/**
 * Parse command line arguments to get config path
 */
export function parseArgs(args: string[]): { configPath: string } {
    let configPath = 'config.json';

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--config' || args[i] === '-c') {
            if (i + 1 < args.length) {
                configPath = args[i + 1];
                i++;
            } else {
                throw new Error('Missing value for --config argument');
            }
        }
    }

    return { configPath };
}
