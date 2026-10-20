import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../../src/tools/tool-generator.js';
import type { ConnectionManager } from '../../src/db/connection-manager.js';

export async function connectTools(manager: ConnectionManager, protection = true) {
    const server = new McpServer({ name: 'test', version: '1' });
    registerAllTools(server, manager, {
        blockDangerousQueries: protection,
        dangerousPatterns: ['DROP', 'TRUNCATE', 'ALTER', 'GRANT', 'REVOKE'],
    }, { name: 'test', version: '1', resultRowLimit: 1000 });
    const client = new Client({ name: 'test-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, async close() { await client.close(); await server.close(); } };
}
