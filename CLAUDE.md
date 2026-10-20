# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP Database Access Server - A Model Context Protocol (MCP) server that provides secure access to MySQL and PostgreSQL databases with unified tools.

## Commands

Use Node.js 22 or newer for development and tests. The test suite uses the newer mock-timer API; the declared server runtime minimum remains Node.js 18.

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev -- --config config.json

# Run in production
npm start -- --config config.json

# Run tests
npm test

# Clean build artifacts
npm run clean
```

## Architecture

The server follows a modular architecture:

- **`src/index.ts`** - Main entry point. Initializes MCP server, loads config, creates connection manager, registers tools.
- **`src/config/`** - Configuration loading and Zod schema validation (`schema.ts`, `loader.ts`)
- **`src/db/`** - Database adapters, connection management, and retry logic
  - `connection-manager.ts` - Manages database connections with SSH tunnel support, lazy connections, and SSH-backed recovery
  - `mysql-adapter.ts` / `postgresql-adapter.ts` - Database-specific implementations of the `DatabaseAdapter` interface, with transient-error retry
  - `connection-retry.ts` - Classifies transient connection errors and provides the `withConnectionRetry` helper
  - `types.ts` - Shared adapter interfaces and types
- **`src/ssh/`** - SSH tunnel management (`tunnel-manager.ts`) for connecting through jump hosts
- **`src/tools/`** - MCP tool registration (`tool-generator.ts`) - registers 2 unified tools: `list_databases`, `execute_sql`
- **`src/utils/`** - Query validation and output formatting

## Key Design Patterns

- **Unified Tools**: Regardless of how many connections configured, only 2 tools are registered (`list_databases`, `execute_sql`). Connection ID is passed as a parameter.
- **Lazy SSH**: `lazy: true` defers connection until the first query or unresolved wildcard discovery through `list_databases`.
- **Adapter Pattern**: `DatabaseAdapter` interface abstracts MySQL/PostgreSQL differences.
- **SSH Tunnel Manager**: Handles multihop jump hosts with automatic reconnection.
- **Connection Resilience**: Retry transient acquisition/setup failures, but never replay user SQL after submission; report unknown outcomes and recover for later calls. Concurrent requests share initialization/recovery. SSH automatic reconnect uses five cancellable exponential-backoff attempts.
- **SQL Contract**: `execute_sql` requires a database and exactly one statement. Dialect-aware validation rejects batches independently of dangerous-keyword policy.
- **Tests**: Unit/integration tests live in `tests/` and run with `node --test` via `npm test`.

## Configuration

See `config.example.json` for reference. Key fields:
- `connections[].id` - Must be lowercase alphanumeric with underscores
- `connections[].databases` - Use `"*"` for auto-discovery, or array for specific databases
- `ssh` - Optional, supports `jumpHosts` array for multihop

## Available Tools

| Tool | Description |
|------|-------------|
| `list_databases` | List all configured connections and their databases |
| `execute_sql` | Execute SQL on specified connection/database |
