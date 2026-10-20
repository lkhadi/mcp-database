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
    operation?: Promise<TunnelInfo>;
    closed: boolean;
    abort: AbortController;
    onDisconnected?: () => void;
}

/**
 * SSH Tunnel Manager - handles SSH tunnels with multihop and auto-reconnect
 */
export class SSHTunnelManager {
    private tunnels: Map<string, TunnelState> = new Map();
    private disconnectedClients = new WeakSet<Client>();

    /**
     * Register a tunnel configuration (does not connect yet if lazy)
     */
    async register(connectionId: string, config: SSHConfig): Promise<TunnelInfo | null> {
        if (!config.enabled) {
            return null;
        }

        // Re-registration must release the previous generation first.
        if (this.tunnels.has(connectionId)) await this.close(connectionId);

        const state: TunnelState = {
            config,
            connectionId,
            info: null,
            clients: [],
            server: null,
            reconnectAttempts: 0,
            isReconnecting: false,
            closed: false,
            abort: new AbortController(),
        };

        this.tunnels.set(connectionId, state);

        // If not lazy, connect immediately
        if (!config.lazy) {
            return this.ensureConnected(connectionId);
        }

        return null;
    }

    /**
     * Ensure tunnel is connected (for lazy connections)
     */
    async ensureConnected(connectionId: string): Promise<TunnelInfo> {
        const state = this.tunnels.get(connectionId);
        if (!state || state.closed) {
            throw new Error(`No tunnel registered for connection: ${connectionId}`);
        }

        if (state.operation) return state.operation;
        if (state.info?.isConnected) {
            return state.info;
        }

        return this.runConnection(state, () => this.connect(connectionId));
    }

    /**
     * Recreate a tunnel and return its current local endpoint.
     */
    async reconnect(connectionId: string): Promise<TunnelInfo> {
        const state = this.tunnels.get(connectionId);
        if (!state || state.closed) {
            throw new Error(`No tunnel registered for connection: ${connectionId}`);
        }

        if (state.operation) return state.operation;

        console.error(`[${connectionId}] Recreating SSH tunnel...`);
        state.isReconnecting = true;
        state.reconnectAttempts = 0;
        if (state.info) {
            state.info.isConnected = false;
        }

        return this.runConnection(state, async () => {
            try {
                await this.cleanupTunnel(state);
                return await this.connect(connectionId);
            } finally {
                state.isReconnecting = false;
            }
        });
    }

    private async runConnection(state: TunnelState, operation: () => Promise<TunnelInfo>): Promise<TunnelInfo> {
        if (state.operation) return state.operation;
        const pending = operation();
        state.operation = pending;
        try {
            return await pending;
        } finally {
            if (state.operation === pending) state.operation = undefined;
            // A disconnect may arrive after publication but before this promise
            // settles. Its event handler defers recovery until ownership clears.
            if (!state.closed && state.info && !state.info.isConnected && !state.isReconnecting) {
                void this.handleDisconnect(state.connectionId).catch((error) => {
                    if (!state.closed) console.error(`[${state.connectionId}] Reconnect failed:`, error);
                });
            }
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
        if (!state || state.closed) {
            throw new Error(`No tunnel registered for connection: ${connectionId}`);
        }

        const { config } = state;

        console.error(`[${connectionId}] Establishing SSH tunnel to ${config.host}...`);

        let removeEstablishmentListeners = () => {};
        try {
            // Build the chain of SSH connections (jump hosts + final host)
            const clients = await this.buildConnectionChain(connectionId, config, state.abort.signal);
            state.clients = clients;
            if (state.closed) throw new Error(`SSH tunnel closed: ${connectionId}`);
            let disconnected = clients.some((client) => this.disconnectedClients.has(client));
            const onDisconnected = () => { disconnected = true; };
            for (const client of clients) {
                client.on('close', onDisconnected);
                client.on('end', onDisconnected);
                client.on('error', onDisconnected);
            }
            removeEstablishmentListeners = () => {
                for (const client of clients) {
                    client.off('close', onDisconnected);
                    client.off('end', onDisconnected);
                    client.off('error', onDisconnected);
                }
            };
            if (disconnected) throw new Error(`SSH client disconnected during establishment: ${connectionId}`);

            // The last client in the chain is our tunnel endpoint
            const finalClient = clients[clients.length - 1];

            // Create local forwarding server
            const { server, localPort } = await this.createForwardingServer(
                finalClient,
                config.targetHost,
                config.targetPort
            );

            state.server = server;
            if (state.closed || disconnected) throw new Error(`SSH tunnel closed or disconnected during establishment: ${connectionId}`);
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
            await this.cleanupTunnel(state);
            console.error(`[${connectionId}] SSH tunnel failed:`, error);
            throw error;
        } finally {
            removeEstablishmentListeners();
        }
    }

    /**
     * Build chain of SSH connections for multihop
     */
    private async buildConnectionChain(connectionId: string, config: SSHConfig, signal?: AbortSignal): Promise<Client[]> {
        const clients: Client[] = [];
        const jumpHosts = config.jumpHosts ?? [];

        // Connect through each jump host
        let previousClient: Client | null = null;

        try {
            for (let i = 0; i < jumpHosts.length; i++) {
                const jumpHost = jumpHosts[i];
                console.error(`[${connectionId}] Connecting through jump host ${i + 1}: ${jumpHost.host}...`);

                const client = await this.connectToHost(
                    jumpHost,
                    previousClient,
                    i === 0 ? null : jumpHosts[i - 1],
                    signal
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
                jumpHosts.length > 0 ? jumpHosts[jumpHosts.length - 1] : null,
                signal
            );
            clients.push(finalClient);

            if (jumpHosts.length > 0) {
                console.error(`[${connectionId}] SSH tunnel chain established through ${jumpHosts.length} jump host(s)`);
            }

            return clients;
        } catch (error) {
            for (const client of clients.reverse()) {
                try { client.end(); } catch { /* Continue releasing the chain. */ }
            }
            throw error;
        }
    }

    /**
     * Connect to a single SSH host, optionally through a previous client
     */
    private async connectToHost(
        hostConfig: JumpHostConfig,
        previousClient: Client | null,
        previousHostConfig: JumpHostConfig | null,
        signal?: AbortSignal
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
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                try { client.destroy(); } catch { /* Preserve the handshake failure. */ }
                reject(error);
            };
            const onAbort = () => fail(new Error(`SSH connection cancelled: ${hostConfig.host}`));
            signal?.addEventListener('abort', onAbort, { once: true });

            client.on('ready', () => {
                if (settled) return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                resolvePromise(client);
            });

            client.once('close', () => {
                this.disconnectedClients.add(client);
                fail(new Error(`SSH connection closed before ready: ${hostConfig.host}`));
            });
            client.once('end', () => {
                this.disconnectedClients.add(client);
                fail(new Error(`SSH connection ended before ready: ${hostConfig.host}`));
            });

            client.on('error', (err: Error) => {
                if (!settled) {
                    fail(new Error(`SSH connection to ${hostConfig.host} failed: ${err.message}`));
                    return;
                }

                // The listener has to stay attached for the client's whole life:
                // an 'error' event with no listener terminates the process.
                console.error(`[ssh] ${hostConfig.host} errored after connect: ${err.message}`);
            });

            if (signal?.aborted) { onAbort(); return; }

            if (previousClient && previousHostConfig) {
                // Connect through the previous client's forwarding
                try { previousClient.forwardOut(
                    '127.0.0.1',
                    0,
                    hostConfig.host,
                    hostConfig.port ?? 22,
                    (err: Error | undefined, stream: ClientChannel) => {
                        if (err) {
                            fail(new Error(`Failed to forward through ${previousHostConfig.host}: ${err.message}`));
                            return;
                        }
                        if (settled) { stream.destroy(); return; }
                        try {
                            client.connect({ ...connectConfig, sock: stream });
                        } catch (error) {
                            stream.destroy();
                            fail(error instanceof Error ? error : new Error(String(error)));
                        }
                    }
                ); } catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            } else {
                // Direct connection
                try { client.connect(connectConfig); }
                catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
            }
        });
    }

    /**
     * Get authentication configuration from credentials
     */
    private getAuthConfig(creds: JumpHostConfig): { password?: string; privateKey?: Buffer; passphrase?: string } {
        const auth: { password?: string; privateKey?: Buffer; passphrase?: string } = {};

        // Try private key first
        if (creds.privateKey) {
            const keyPath = this.resolveKeyPath(creds.privateKey);
            if (existsSync(keyPath)) {
                auth.privateKey = readFileSync(keyPath);
                auth.passphrase = creds.passphrase;
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
            if (state.closed) return;
            if (state.info) {
                state.info.isConnected = false;
            }

            // Detached from any await chain, so an unhandled rejection here
            // would terminate the process instead of failing one reconnect.
            void this.handleDisconnect(connectionId).catch((error) => {
                if (state.closed) return;
                const message = error instanceof Error ? error.message : String(error);
                console.error(`[${connectionId}] Reconnect handler failed: ${message}`);
            });
        };

        state.onDisconnected = onDisconnected;
        finalClient.on('close', onDisconnected);
        finalClient.on('end', onDisconnected);
    }

    /**
     * Handle tunnel disconnect with auto-reconnect
     */
    private async handleDisconnect(connectionId: string): Promise<void> {
        const state = this.tunnels.get(connectionId);
        if (!state || state.closed || state.isReconnecting || state.operation) return;

        state.isReconnecting = true;
        await this.runConnection(state, async () => {
            let lastError: unknown;
            try {
                for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
                    if (state.closed) throw new Error(`SSH tunnel closed: ${connectionId}`);
                    state.reconnectAttempts = attempt;
                    const delay = RECONNECT_BASE_DELAY * 2 ** (attempt - 1);
                    console.error(`[${connectionId}] SSH tunnel disconnected. Reconnecting in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...`);
                    await this.cleanupTunnel(state);
                    await this.waitForReconnect(state, delay);
                    try {
                        const info = await this.connect(connectionId);
                        console.error(`[${connectionId}] SSH tunnel reconnected successfully`);
                        return info;
                    } catch (error) {
                        if (state.closed) throw error;
                        lastError = error;
                        console.error(`[${connectionId}] Reconnection attempt ${attempt} failed:`, error);
                    }
                }
                throw new Error(`SSH reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts: ${connectionId}`, { cause: lastError });
            } finally {
                state.isReconnecting = false;
            }
        });
    }

    private waitForReconnect(state: TunnelState, delay: number): Promise<void> {
        return new Promise((resolvePromise, reject) => {
            const signal = state.abort.signal;
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', cancel);
                resolvePromise();
            }, delay);
            const cancel = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancel);
                reject(new Error(`SSH reconnect cancelled: ${state.connectionId}`));
            };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
        });
    }

    /**
     * Clean up tunnel resources
     */
    private async cleanupTunnel(state: TunnelState): Promise<void> {
        if (state.info) state.info.isConnected = false;
        state.info = null;
        const clients = state.clients;
        state.clients = [];
        const finalClient = clients[clients.length - 1];
        if (state.onDisconnected && finalClient) {
            finalClient.off('close', state.onDisconnected);
            finalClient.off('end', state.onDisconnected);
        }
        state.onDisconnected = undefined;
        // Close the forwarding server
        if (state.server) {
            const server = state.server;
            state.server = null;
            try { server.close(); } catch { /* Still release SSH clients. */ }
        }

        // Close all SSH clients in reverse order
        for (let i = clients.length - 1; i >= 0; i--) {
            try {
                clients[i].end();
            } catch {
                // Ignore errors during cleanup
            }
        }
    }

    /**
     * Close a specific tunnel
     */
    async close(connectionId: string): Promise<void> {
        const state = this.tunnels.get(connectionId);
        if (!state) return;

        console.error(`[${connectionId}] Closing SSH tunnel...`);
        state.closed = true;
        state.abort.abort();
        this.tunnels.delete(connectionId);
        await this.cleanupTunnel(state);
        await Promise.allSettled(state.operation ? [state.operation] : []);
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
