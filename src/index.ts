#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, parseArgs } from './config/loader.js';
import { ConnectionManager } from './db/connection-manager.js';
import { registerAllTools } from './tools/tool-generator.js';

/**
 * Main entry point
 */
async function main(): Promise<void> {
    try {
        // Parse command line arguments
        const args = parseArgs(process.argv.slice(2));

        // Load configuration
        console.error(`Loading configuration from: ${args.configPath}`);
        const config = loadConfig(args.configPath);

        // Initialize connection manager
        console.error('Initializing database connections...');
        const connectionManager = new ConnectionManager();
        await connectionManager.initialize(config.connections);

        // Create MCP server
        const server = new McpServer({
            name: config.server.name,
            version: config.server.version,
        });

        // Register all tools
        registerAllTools(server, connectionManager, config.security, config.server);

        // Handle graceful shutdown
        const shutdown = async () => {
            console.error('Shutting down...');
            await connectionManager.closeAll();
            process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Connect to stdio transport
        const transport = new StdioServerTransport();
        await server.connect(transport);

        console.error(`${config.server.name} v${config.server.version} running on stdio`);
    } catch (error) {
        console.error('Fatal error:', error instanceof Error ? error.message : error);
        process.exit(1);
    }
}

main();
