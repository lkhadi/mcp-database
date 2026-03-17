import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ConnectionManager,
  ResolvedConnection,
} from "../db/connection-manager.js";
import type { SecurityConfig, ServerOptions } from "../config/schema.js";
import { QueryValidator } from "../utils/query-validator.js";
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
  registerListDatabasesTool(server, connections);
  registerExecuteSqlTool(
    server,
    connections,
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
  connections: ResolvedConnection[]
): void {
  server.tool(
    "list_databases",
    "List all available database connections and their databases",
    {},
    async () => {
      const formatted = formatDatabaseList(
        connections.map((c) => ({
          id: c.id,
          type: c.type,
          databases: c.databases,
        }))
      );

      return {
        content: [{ type: "text", text: formatted }],
      };
    }
  );
}

/**
 * Register unified execute_sql tool
 */
function registerExecuteSqlTool(
    server: McpServer,
    connections: ResolvedConnection[],
    validator: QueryValidator,
    maxRows: number
): void {
    const connectionIds = connections.map((c) => c.id);

    server.tool(
        'execute_sql',
        'Execute SQL query on a database connection. Use list_databases to see available connections and databases.',
        {
            connection: z
                .string()
                .describe(`Connection ID. Available: ${connectionIds.join(', ')}`),
            sql: z.string().describe('SQL query or multiple statements separated by semicolons'),
            database: z
                .string()
                .optional()
                .describe('Database name. If omitted, uses the first available database for the connection.'),
        },
        async ({ connection, sql, database }) => {
            // Find the connection
            const conn = connections.find((c) => c.id === connection);
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

            const defaultDb = conn.databases[0] ?? '';
            const db = database ?? defaultDb;
            const dbList = conn.databases.join(', ');

            // Validate database exists
            if (!conn.databases.includes(db)) {
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
            const validation = validator.validate(sql);
            if (!validation.valid) {
                return {
                    content: [{ type: 'text', text: `Error: ${validation.reason}` }],
                    isError: true,
                };
            }

            try {
                const result = await conn.adapter.execute(sql, db);
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

