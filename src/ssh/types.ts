/**
 * Represents an established SSH tunnel
 */
export interface TunnelInfo {
    localHost: string;      // Always '127.0.0.1'
    localPort: number;      // Dynamically assigned port
    targetHost: string;
    targetPort: number;
    isConnected: boolean;
}

/**
 * SSH tunnel state for management (internal use)
 */
export interface TunnelState {
    connectionId: string;
    info: TunnelInfo | null;
    clients: unknown[];     // Array of ssh2 Client instances
    server: unknown;        // net.Server instance
    reconnectAttempts: number;
    isReconnecting: boolean;
}

/**
 * Tunnel manager events
 */
export type TunnelEvent =
    | { type: 'connecting'; connectionId: string }
    | { type: 'connected'; connectionId: string; info: TunnelInfo }
    | { type: 'disconnected'; connectionId: string; error?: Error }
    | { type: 'reconnecting'; connectionId: string; attempt: number }
    | { type: 'error'; connectionId: string; error: Error };
