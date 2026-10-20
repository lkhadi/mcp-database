# MCP Database Access Server

A Model Context Protocol (MCP) server that provides secure access to **MySQL** and **PostgreSQL** databases with unified tools for multiple connections.

## Features

- 🔌 **Multi-Database Support** - Connect to MySQL and PostgreSQL simultaneously
- 🔧 **Unified Tools** - 2 tools total regardless of connection count
- 🔍 **Database Discovery** - Use `"*"` to auto-discover all accessible databases on a host
- 🛡️ **Query Safety** - Blocks dangerous queries (DROP, TRUNCATE, etc.) by default
- 📊 **LLM-Friendly Output** - Formatted tables and results optimized for AI assistants
- 🔐 **SSH Tunnel Support** - Connect through SSH gateways with multihop/jump host support
- 🔄 **Connection Resilience** - Automatic retry and recovery for transient database and SSH tunnel failures

## Installation

```bash
npm install
npm run build
```

## Configuration

Create a `config.json` file:

```json
{
  "connections": [
    {
      "id": "mydb",
      "type": "mysql",
      "host": "localhost",
      "port": 3306,
      "username": "root",
      "password": "secret",
      "databases": "*"
    }
  ],
  "server": {
    "name": "db-access",
    "version": "1.0.0",
    "resultRowLimit": 1000
  },
  "security": {
    "blockDangerousQueries": true,
    "dangerousPatterns": ["DROP", "TRUNCATE", "ALTER", "GRANT", "REVOKE"]
  }
}
```

### Configuration Options

| Field                            | Type                    | Description                                        |
| -------------------------------- | ----------------------- | -------------------------------------------------- |
| `connections[].id`               | string                  | Unique identifier (used as `connection` parameter) |
| `connections[].type`             | `mysql` \| `postgresql` | Database type                                      |
| `connections[].host`             | string                  | Database host                                      |
| `connections[].port`             | number                  | Database port                                      |
| `connections[].username`         | string                  | Database username                                  |
| `connections[].password`         | string                  | Database password                                  |
| `connections[].databases`        | `string[]` \| `"*"`     | List of databases or `"*"` for auto-discovery      |
| `connections[].ssh`              | object                  | Optional SSH tunnel configuration                  |
| `server.resultRowLimit`          | number                  | Max rows returned (default: 1000)                  |
| `security.blockDangerousQueries` | boolean                 | Block DROP, TRUNCATE, etc. (default: true)         |

## SSH Tunneling

Connect to databases through SSH gateways with support for multihop (jump hosts) and both password and private key authentication.

### Basic SSH Tunnel

```json
{
  "id": "production",
  "type": "mysql",
  "host": "127.0.0.1",
  "port": 3306,
  "username": "db_user",
  "password": "db_password",
  "databases": ["production_db"],
  "ssh": {
    "enabled": true,
    "host": "bastion.example.com",
    "port": 22,
    "username": "ssh_user",
    "privateKey": "~/.ssh/id_rsa",
    "targetHost": "internal-db.private",
    "targetPort": 3306
  }
}
```

### Multihop SSH (Jump Hosts)

**Connection flow:** `You → jumpHosts[0] → jumpHosts[1] → ... → ssh.host → targetHost`

```
┌──────────┐      ┌─────────────────┐      ┌──────────────┐      ┌──────────────┐
│   You    │ ───► │  jumpHosts[0]   │ ───► │   ssh.host   │ ───► │  targetHost  │
│          │      │  (first hop)    │      │  (final SSH) │      │  (Database)  │
└──────────┘      └─────────────────┘      └──────────────┘      └──────────────┘
```

**Example:** Connect through bastion, then internal jump host, then to database:

```json
{
  "id": "secure_db",
  "type": "mysql",
  "host": "127.0.0.1",
  "port": 3306,
  "username": "db_user",
  "password": "db_password",
  "databases": ["app_db"],
  "ssh": {
    "enabled": true,
    "host": "internal-jump.private",
    "port": 22,
    "username": "deploy",
    "privateKey": "~/.ssh/deploy_key",
    "targetHost": "database.internal",
    "targetPort": 3306,
    "jumpHosts": [
      {
        "host": "bastion.example.com",
        "port": 22,
        "username": "jump_user",
        "privateKey": "~/.ssh/bastion_key"
      }
    ]
  }
}
```

This connects: `You → bastion.example.com → internal-jump.private → database.internal:3306`

### SSH Options

| Field            | Type    | Description                                           |
| ---------------- | ------- | ----------------------------------------------------- |
| `ssh.enabled`    | boolean | Enable SSH tunneling                                  |
| `ssh.lazy`       | boolean | Defer connection until first query or wildcard discovery (default: false) |
| `ssh.host`       | string  | **Final SSH hop** before database                     |
| `ssh.port`       | number  | SSH port (default: 22)                                |
| `ssh.username`   | string  | SSH username                                          |
| `ssh.password`   | string  | SSH password (optional)                               |
| `ssh.privateKey` | string  | Path to private key file (optional, supports `~`)     |
| `ssh.passphrase` | string  | Passphrase for encrypted keys (optional)              |
| `ssh.targetHost` | string  | Database host **from final SSH server's perspective** |
| `ssh.targetPort` | number  | Database port                                         |
| `ssh.jumpHosts`  | array   | Ordered list of **intermediate** jump hosts           |

### Auto-Reconnect

SSH tunnels retry a disconnect after 1, 2, 4, 8, and 16 seconds, stopping on success or after five failures. Concurrent requests share connection and recovery work. Shutdown cancels pending reconnect delays and SSH handshakes.

With `databases: "*"`, failed startup discovery is retried by `list_databases` or `execute_sql`. Listing an explicit database list keeps a lazy SSH connection unopened. Listing an unresolved wildcard connection establishes it to discover its databases; failures are reported alongside available connections.

## Usage

### Start the Server

```bash
npm start -- --config config.json
```

### With Claude Desktop

Add to `~/.config/claude/mcp_config.json`:

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": [
        "/path-to-mcp/dist/index.js",
        "--config",
        "/path-to-config/config.json"
      ]
    }
  }
}
```

### With Cursor

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": [
        "/path-to-mcp/dist/index.js",
        "--config",
        "/path-to-config/config.json"
      ]
    }
  }
}
```

## Available Tools

The server provides **2 unified tools** regardless of how many connections are configured:

| Tool             | Parameters                       | Description                                         |
| ---------------- | -------------------------------- | --------------------------------------------------- |
| `list_databases` | _(none)_                         | List all configured connections and their databases |
| `execute_sql`    | `connection`, `sql`, `database` | Execute one SQL statement per call                                 |

### Parameters

| Parameter    | Required | Description                                                                                          |
| ------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| `connection` | Yes      | Connection ID from config (defined in `connections[].id`). Available IDs shown in tool description |
| `database`   | Yes      | Database name from the configured or discovered list                                                 |
| `sql`        | Yes      | Exactly one SQL statement; batches are rejected before execution, including when dangerous-query blocking is disabled |

Trailing semicolons and semicolons inside quoted strings are supported. Multiple result sets from stored routines are not supported; if a routine returns them, the tool reports that SQL executed but the results cannot be displayed. Do not automatically retry that call.

### Example Usage (in Claude/Cursor)

```
> Show me all available database connections and their databases
> Execute "SELECT * FROM users LIMIT 5" on connection "mydb" database "app_db"
> Execute "SELECT * FROM orders WHERE status = 'pending' LIMIT 10" on connection "production" database "shop_db"
```

## Companion Agent Skill

The separately distributed companion skill guides agents through database discovery, schema inspection, SQL reports, and authorized data corrections. See the [companion skill guide](docs/mcp-database-skill.md) for prerequisites, examples, permissions, and limitations.

The skill package is not included in this repository. Loading it does not install or configure this MCP server. Server setup and the skill's delivery through an agent or marketplace are separate steps.

## Development

Use Node.js 22 or newer for development and tests. The test suite uses the newer mock-timer API; the declared server runtime minimum remains Node.js 18.

```bash
# Run in development mode
npm run dev -- --config config.json

# Build for production
npm run build

# Run tests
npm test

# Clean build artifacts
npm run clean
```

## Security

Connection acquisition and setup failures can be retried automatically. Once user SQL has been submitted, a lost connection returns an **unknown outcome** error instead of replaying the statement, even for `SELECT` (which may invoke functions with side effects). Check database state before explicitly retrying. Pool and SSH recovery still prepare later requests for use.

- Dangerous queries (DROP, TRUNCATE, ALTER, GRANT, REVOKE) are blocked by default
- Validation distinguishes MySQL and PostgreSQL strings, identifiers, and comments. Executable MySQL comments and ambiguous or unterminated quotes are rejected. Prefer doubled quotes for escaping; PostgreSQL `E'...'` escape strings are supported.
- The keyword guard is not a full SQL parser: dynamically executed SQL inside strings or stored routines still requires appropriately restricted database privileges.
- Set `blockDangerousQueries: false` to disable this protection
- Access control relies on database credential privileges
- Passwords are stored in config file - use appropriate file permissions

## License

The server and repository documentation are MIT-licensed — see [LICENSE](./LICENSE). The companion skill is distributed separately with its own copy of the MIT license. Separately licensed material retains its own terms.
