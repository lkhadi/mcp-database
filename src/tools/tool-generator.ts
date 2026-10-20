import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionManager } from "../db/connection-manager.js";
import type { SecurityConfig, ServerOptions } from "../config/schema.js";
import { QueryValidator } from "../utils/query-validator.js";
import { assertSingleStatement } from '../utils/sql-lexer.js';
import {
  formatQueryResult,
  formatDatabaseList,
} from "../utils/formatter.js";
import { z } from "zod";

/**
 * Register all tools for all database connections
 */
export function registerAllTools(
  server: McpServer,
  connectionManager: ConnectionManager,
  security: SecurityConfig,
  serverOptions: ServerOptions
): void {
  const connections = connectionManager.getAllConnections();
  const validator = new QueryValidator(
    security.dangerousPatterns,
    security.blockDangerousQueries
  );

  // Register unified tools (2 tools total, regardless of connection count)
  registerListDatabasesTool(server, connectionManager);
  registerExecuteSqlTool(
    server,
    connectionManager,
    validator,
    serverOptions.resultRowLimit
  );

  console.error(
    `Registered 2 unified tools for ${connections.length} connection(s)`
  );
}

/**
 * Register the list_databases tool
 */
function registerListDatabasesTool(
  server: McpServer,
  connectionManager: ConnectionManager
): void {
  server.tool(
    "list_databases",
    "List all available database connections and their databases",
    {},
    async () => {
      const errors: string[] = [];
      for (const connection of connectionManager.getAllConnections()) {
        if (connection.databases.length > 0) continue;
        try {
          await connectionManager.getConnectionAsync(connection.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`[${connection.id}] Discovery unavailable: ${message}`);
        }
      }
      const formatted = formatDatabaseList(
        connectionManager.getAllConnections().map((c) => ({
          id: c.id,
          type: c.type,
          databases: c.databases,
        }))
      );

      return {
        content: [{ type: "text", text: [formatted, ...errors].join('\n') }],
      };
    }
  );
}

/**
 * Register unified execute_sql tool
 */
function registerExecuteSqlTool(
    server: McpServer,
    connectionManager: ConnectionManager,
    validator: QueryValidator,
    maxRows: number
): void {
    const connectionIds = connectionManager.getAllConnections().map((c) => c.id);

    server.tool(
        'execute_sql',
        'Execute SQL query on a database connection. Use list_databases to see available connections and databases.',
        {
            connection: z
                .string()
                .describe(`Connection ID. Available: ${connectionIds.join(', ')}`),
            sql: z.string().describe('Exactly one SQL statement per call; batches are not supported'),
            database: z
                .string()
                .describe('Database name to execute the query against. Required.'),
        },
        async ({ connection, sql, database }) => {
            // Find the connection
            const conn = connectionManager.getAllConnections().find((c) => c.id === connection);
            if (!conn) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: Connection "${connection}" not found. Available: ${connectionIds.join(', ')}`,
                        },
                    ],
                    isError: true,
                };
            }

            const db = database;
            const dbList = conn.databases.join(', ');

            // Validate database exists
            if (conn.databases.length > 0 && !conn.databases.includes(db)) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error: Database "${db}" not found in connection "${connection}". Available: ${dbList}`,
                        },
                    ],
                    isError: true,
                };
            }

            // Validate query safety
            const validation = validator.validate(sql, conn.type);
            if (!validation.valid) {
                return {
                    content: [{ type: 'text', text: `Error: ${validation.reason}` }],
                    isError: true,
                };
            }

            try {
                assertSingleStatement(sql, conn.type);
                const current = await connectionManager.getConnectionAsync(connection);
                if (!current || !current.databases.includes(db)) {
                    return {
                        content: [{ type: 'text', text: `Error: Database "${db}" not found in connection "${connection}". Available: ${current?.databases.join(', ') ?? ''}` }],
                        isError: true,
                    };
                }
                const result = await current.adapter.execute(sql, db);
                const formatted = formatQueryResult(result, maxRows);

                return {
                    content: [{ type: 'text', text: formatted }],
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: 'text', text: `SQL Error: ${message}` }],
                    isError: true,
                };
            }
        }
    );
}
