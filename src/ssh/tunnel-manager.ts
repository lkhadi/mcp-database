import { Client, ClientChannel } from 'ssh2';
import { createServer, Socket, Server } from 'net';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { SSHConfig, JumpHostConfig } from '../config/schema.js';

/**
 * Maximum reconnection attempts before giving up
 */
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Base delay for exponential backoff (ms)
 */
const RECONNECT_BASE_DELAY = 1000;

/**
 * Represents an established SSH tunnel
 */
export interface TunnelInfo {
    localHost: string;
    localPort: number;
    targetHost: string;
    targetPort: number;
    isConnected: boolean;
}

/**
 * Internal tunnel state for management
 */
interface TunnelState {
    config: SSHConfig;
    connectionId: string;
    info: TunnelInfo | null;
    clients: Client[];
    server: Server | null;
    reconnectAttempts: number;
    isReconnecting: boolean;
}

/**
 * SSH Tunnel Manager - handles SSH tunnels with multihop and auto-reconnect
 */
export class SSHTunnelManager {
    private tunnels: Map<string, TunnelState> = new Map();

    /**
     * Register a tunnel configuration (does not connect yet if lazy)
     */
    async register(connectionId: string, config: SSHConfig): Promise<TunnelInfo | null> {
        if (!config.enabled) {
            return null;
        }

        const state: TunnelState = {
            config,
            connectionId,
            info: null,
            clients: [],
            server: null,
            reconnectAttempts: 0,
            isReconnecting: false,
        };

        this.tunnels.set(connectionId, state);

        // If not lazy, connect immediately
        if (!config.lazy) {
            return this.connect(connectionId);
        }

        return null;
    }

    /**
     * Ensure tunnel is connected (for lazy connections)
     */
    async ensureConnected(connectionId: string): Promise<TunnelInfo> {
        const state = this.tunnels.get(connectionId);
        if (!state) {
            throw new Error(`No tunnel registered for connection: ${connectionId}`);
        }

        if (state.info?.isConnected) {
            return state.info;
        }

        return this.connect(connectionId);
    }

    /**
     * Recreate a tunnel and return its current local endpoint.
     */
    async reconnect(connectionId: string): Promise<TunnelInfo> {
        const state = this.tunnels.get(connectionId);
        if (!state) {
            throw new Error(`No tunnel registered for connection: ${connectionId}`);
        }

        console.error(`[${connectionId}] Recreating SSH tunnel...`);
        state.isReconnecting = true;
        state.reconnectAttempts = 0;
        if (state.info) {
            state.info.isConnected = false;
        }

        await this.cleanupTunnel(state);
        state.info = null;

        try {
            return await this.connect(connectionId);
        } finally {
            state.isReconnecting = false;
        }
    }

    /**
     * Check if a connection has SSH tunnel configured
     */
    hasTunnel(connectionId: string): boolean {
        return this.tunnels.has(connectionId);
    }

    /**
     * Get tunnel info for a connection
     */
    getTunnelInfo(connectionId: string): TunnelInfo | null {
        return this.tunnels.get(connectionId)?.info ?? null;
    }

    /**
     * Establish SSH tunnel connection
     */
    private async connect(connectionId: string): Promise<TunnelInfo> {
        const state = this.tunnels.get(connectionId);
        if (!state) {
            throw new Error(`No tunnel registered for connection: ${connectionId}`);
        }

        const { config } = state;

        console.error(`[${connectionId}] Establishing SSH tunnel to ${config.host}...`);

        try {
            // Build the chain of SSH connections (jump hosts + final host)
            const clients = await this.buildConnectionChain(connectionId, config);
            state.clients = clients;

            // The last client in the chain is our tunnel endpoint
            const finalClient = clients[clients.length - 1];

            // Create local forwarding server
            const { server, localPort } = await this.createForwardingServer(
                finalClient,
                config.targetHost,
                config.targetPort
            );

            state.server = server;
            state.info = {
                localHost: '127.0.0.1',
                localPort,
                targetHost: config.targetHost,
                targetPort: config.targetPort,
                isConnected: true,
            };

            state.reconnectAttempts = 0;

            console.error(
                `[${connectionId}] SSH tunnel established: 127.0.0.1:${localPort} -> ${config.targetHost}:${config.targetPort}`
            );

            // Set up disconnect handlers for auto-reconnect
            this.setupAutoReconnect(connectionId);

            return state.info;
        } catch (error) {
            console.error(`[${connectionId}] SSH tunnel failed:`, error);
            throw error;
        }
    }

    /**
     * Build chain of SSH connections for multihop
     */
    private async buildConnectionChain(connectionId: string, config: SSHConfig): Promise<Client[]> {
        const clients: Client[] = [];
        const jumpHosts = config.jumpHosts ?? [];

        // Connect through each jump host
        let previousClient: Client | null = null;

        for (let i = 0; i < jumpHosts.length; i++) {
            const jumpHost = jumpHosts[i];
            console.error(`[${connectionId}] Connecting through jump host ${i + 1}: ${jumpHost.host}...`);

            const client = await this.connectToHost(
                jumpHost,
                previousClient,
                i === 0 ? null : jumpHosts[i - 1]
            );
            clients.push(client);
            previousClient = client;
        }

        // Connect to final SSH host
        console.error(`[${connectionId}] Connecting to final SSH host: ${config.host}...`);
        const finalClient = await this.connectToHost(
            {
                host: config.host,
                port: config.port ?? 22,
                username: config.username,
                password: config.password,
                privateKey: config.privateKey,
                passphrase: config.passphrase,
            },
            previousClient,
            jumpHosts.length > 0 ? jumpHosts[jumpHosts.length - 1] : null
        );
        clients.push(finalClient);

        if (jumpHosts.length > 0) {
            console.error(`[${connectionId}] SSH tunnel chain established through ${jumpHosts.length} jump host(s)`);
        }

        return clients;
    }

    /**
     * Connect to a single SSH host, optionally through a previous client
     */
    private async connectToHost(
        hostConfig: JumpHostConfig,
        previousClient: Client | null,
        previousHostConfig: JumpHostConfig | null
    ): Promise<Client> {
        return new Promise((resolvePromise, reject) => {
            const client = new Client();

            const connectConfig = {
                host: hostConfig.host,
                port: hostConfig.port ?? 22,
                username: hostConfig.username,
                ...this.getAuthConfig(hostConfig),
            };

            let settled = false;

            client.on('ready', () => {
                settled = true;
                resolvePromise(client);
            });

            client.on('error', (err: Error) => {
                if (!settled) {
                    settled = true;
                    reject(new Error(`SSH connection to ${hostConfig.host} failed: ${err.message}`));
                    return;
                }

                // The listener has to stay attached for the client's whole life:
                // an 'error' event with no listener terminates the process.
                console.error(`[ssh] ${hostConfig.host} errored after connect: ${err.message}`);
            });

            if (previousClient && previousHostConfig) {
                // Connect through the previous client's forwarding
                previousClient.forwardOut(
                    '127.0.0.1',
                    0,
                    hostConfig.host,
                    hostConfig.port ?? 22,
                    (err: Error | undefined, stream: ClientChannel) => {
                        if (err) {
                            reject(new Error(`Failed to forward through ${previousHostConfig.host}: ${err.message}`));
                            return;
                        }
                        client.connect({
                            ...connectConfig,
                            sock: stream,
                        });
                    }
                );
            } else {
                // Direct connection
                client.connect(connectConfig);
            }
        });
    }

    /**
     * Get authentication configuration from credentials
     */
    private getAuthConfig(creds: JumpHostConfig): { password?: string; privateKey?: Buffer } {
        const auth: { password?: string; privateKey?: Buffer } = {};

        // Try private key first
        if (creds.privateKey) {
            const keyPath = this.resolveKeyPath(creds.privateKey);
            if (existsSync(keyPath)) {
                auth.privateKey = readFileSync(keyPath);
            } else {
                console.error(`Warning: Private key not found at ${keyPath}`);
            }
        }

        // Fallback to password
        if (creds.password) {
            auth.password = creds.password;
        }

        return auth;
    }

    /**
     * Resolve private key path (expand ~ to home directory)
     */
    private resolveKeyPath(keyPath: string): string {
        if (keyPath.startsWith('~')) {
            return resolve(homedir(), keyPath.slice(2));
        }
        return resolve(keyPath);
    }

    /**
     * Create a local TCP server that forwards connections through SSH tunnel
     */
    private async createForwardingServer(
        client: Client,
        targetHost: string,
        targetPort: number
    ): Promise<{ server: Server; localPort: number }> {
        return new Promise((resolvePromise, reject) => {
            const server = createServer((socket: Socket) => {
                this.forwardSocket(client, socket, targetHost, targetPort);
            });

            let isListening = false;

            server.on('error', (err: Error) => {
                if (!isListening) {
                    reject(new Error(`Failed to create forwarding server: ${err.message}`));
                    return;
                }

                console.error(`Forwarding server error: ${err.message}`);
            });

            // Listen on random available port
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (typeof address === 'object' && address !== null) {
                    isListening = true;
                    resolvePromise({ server, localPort: address.port });
                } else {
                    reject(new Error('Failed to get local server address'));
                }
            });
        });
    }

    /**
     * Pipe one local connection through the SSH tunnel.
     *
     * Both ends need their own 'error' listener. When a tunnel drops
     * mid-transfer these emit ECONNRESET/EPIPE, and `pipe()` does not forward
     * errors, so an unhandled 'error' event would take the whole server down
     * and the MCP client would see the server disconnect.
     */
    private forwardSocket(
        client: Client,
        socket: Socket,
        targetHost: string,
        targetPort: number
    ): void {
        socket.on('error', (err: Error) => {
            console.error(`Local forwarding socket error: ${err.message}`);
            socket.destroy();
        });

        client.forwardOut(
            '127.0.0.1',
            socket.localPort ?? 0,
            targetHost,
            targetPort,
            (err: Error | undefined, stream: ClientChannel) => {
                if (err) {
                    console.error(`Forward error: ${err.message}`);
                    socket.end();
                    return;
                }

                stream.on('error', (streamError: Error) => {
                    console.error(`Tunnel channel error: ${streamError.message}`);
                    socket.destroy();
                });

                socket.once('close', () => stream.destroy());
                stream.once('close', () => socket.destroy());

                socket.pipe(stream).pipe(socket);
            }
        );
    }

    /**
     * Set up auto-reconnect handlers for tunnel
     */
    private setupAutoReconnect(connectionId: string): void {
        const state = this.tunnels.get(connectionId);
        if (!state) return;

        // Monitor the last client in the chain (closest to target)
        const finalClient = state.clients[state.clients.length - 1];
        if (!finalClient) return;

        const onDisconnected = () => {
            if (state.info) {
                state.info.isConnected = false;
            }

            // Detached from any await chain, so an unhandled rejection here
            // would terminate the process instead of failing one reconnect.
            void this.handleDisconnect(connectionId).catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[${connectionId}] Reconnect handler failed: ${message}`);
            });
        };

        finalClient.on('close', onDisconnected);
        finalClient.on('end', onDisconnected);
    }

    /**
     * Handle tunnel disconnect with auto-reconnect
     */
    private async handleDisconnect(connectionId: string): Promise<void> {
        const state = this.tunnels.get(connectionId);
        if (!state || state.isReconnecting) return;

        if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error(`[${connectionId}] Max reconnection attempts reached. Giving up.`);
            return;
        }

        state.isReconnecting = true;
        state.reconnectAttempts++;

        const delay = RECONNECT_BASE_DELAY * Math.pow(2, state.reconnectAttempts - 1);
        console.error(`[${connectionId}] SSH tunnel disconnected. Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

        // Clean up old resources
        await this.cleanupTunnel(state);

        // Wait before reconnecting
        await new Promise((r) => setTimeout(r, delay));

        try {
            await this.connect(connectionId);
            console.error(`[${connectionId}] SSH tunnel reconnected successfully`);
        } catch (error) {
            console.error(`[${connectionId}] Reconnection failed:`, error);
        } finally {
            state.isReconnecting = false;
        }
    }

    /**
     * Clean up tunnel resources
     */
    private async cleanupTunnel(state: TunnelState): Promise<void> {
        // Close the forwarding server
        if (state.server) {
            state.server.close();
            state.server = null;
        }

        // Close all SSH clients in reverse order
        for (let i = state.clients.length - 1; i >= 0; i--) {
            try {
                state.clients[i].end();
            } catch {
                // Ignore errors during cleanup
            }
        }
        state.clients = [];
    }

    /**
     * Close a specific tunnel
     */
    async close(connectionId: string): Promise<void> {
        const state = this.tunnels.get(connectionId);
        if (!state) return;

        console.error(`[${connectionId}] Closing SSH tunnel...`);
        await this.cleanupTunnel(state);
        this.tunnels.delete(connectionId);
    }

    /**
     * Close all tunnels
     */
    async closeAll(): Promise<void> {
        console.error('Closing all SSH tunnels...');
        const closePromises = Array.from(this.tunnels.keys()).map((id) => this.close(id));
        await Promise.all(closePromises);
    }
}
