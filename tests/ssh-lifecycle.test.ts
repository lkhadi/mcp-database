import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'ssh2';
import type { Server } from 'node:net';
import { SSHTunnelManager } from '../src/ssh/tunnel-manager.js';
import { deferred, sshConfig, FakeClient, FakeServer } from './helpers/lifecycle.js';

function stubTransport(manager: SSHTunnelManager) {
    return manager as unknown as {
        connectToHost: () => Promise<Client>;
        buildConnectionChain: () => Promise<Client[]>;
        createForwardingServer: () => Promise<{ server: Server; localPort: number }>;
    };
}

test('shutdown aborts a pending SSH handshake without waiting for ready', async (t) => {
    const entered = deferred<void>();
    let ended = 0;
    t.mock.method(Client.prototype, 'connect', function (this: Client) { entered.resolve(); return this; });
    t.mock.method(Client.prototype, 'destroy', function (this: Client) { ended++; this.emit('close'); return this; });
    const manager = new SSHTunnelManager();
    await manager.register('test', sshConfig);
    const connecting = manager.ensureConnected('test');
    const rejected = assert.rejects(connecting, /cancel/i);
    await entered.promise;
    await manager.closeAll();
    await rejected;
    assert.equal(ended, 1);
});

test('a connection closing before ready rejects instead of hanging', async (t) => {
    t.mock.method(Client.prototype, 'connect', function (this: Client) {
        queueMicrotask(() => this.emit('close')); return this;
    });
    t.mock.method(Client.prototype, 'end', function (this: Client) { return this; });
    const manager = new SSHTunnelManager();
    await manager.register('test', sshConfig);
    await assert.rejects(() => manager.ensureConnected('test'), /closed before ready/i);
    await manager.closeAll();
});

test('closes successful jump hosts when a later hop fails', async () => {
    const manager = new SSHTunnelManager();
    const jump = new FakeClient();
    let attempts = 0;
    stubTransport(manager).connectToHost = async () => {
        if (++attempts === 1) return jump as unknown as Client;
        throw new Error('final hop unavailable');
    };
    await manager.register('test', { ...sshConfig, jumpHosts: [{ host: 'jump.invalid', port: 22, username: 'test' }] });
    await assert.rejects(() => manager.ensureConnected('test'), /final hop unavailable/);
    await manager.closeAll();
    assert.equal(jump.closes, 1);
});

test('concurrent first use shares one tunnel and shutdown closes all resources', async () => {
    const manager = new SSHTunnelManager();
    const clients: FakeClient[] = [];
    const servers: FakeServer[] = [];
    stubTransport(manager).buildConnectionChain = async () => {
        const client = new FakeClient(); clients.push(client); return [client as unknown as Client];
    };
    stubTransport(manager).createForwardingServer = async () => {
        const server = new FakeServer(); servers.push(server);
        return { server: server as unknown as Server, localPort: 40000 + servers.length };
    };
    await manager.register('test', sshConfig);
    const results = await Promise.all([manager.ensureConnected('test'), manager.ensureConnected('test')]);
    await manager.closeAll();
    assert.equal(clients.length, 1);
    assert.equal(results[0], results[1]);
    assert.deepEqual(clients.map((client) => client.closes), [1]);
    assert.deepEqual(servers.map((server) => server.closes), [1]);
});

test('forwarding failure closes its chain and permits a later attempt', async () => {
    const manager = new SSHTunnelManager();
    const clients: FakeClient[] = [];
    const server = new FakeServer();
    stubTransport(manager).buildConnectionChain = async () => {
        const client = new FakeClient(); clients.push(client); return [client as unknown as Client];
    };
    stubTransport(manager).createForwardingServer = async () => {
        if (clients.length === 1) throw new Error('forwarder failed');
        return { server: server as unknown as Server, localPort: 40000 };
    };
    await manager.register('test', sshConfig);
    await assert.rejects(() => manager.ensureConnected('test'), /forwarder failed/);
    assert.equal(clients[0].closes, 1);
    await manager.ensureConnected('test');
    await manager.closeAll();
    assert.deepEqual(clients.map((client) => client.closes), [1, 1]);
    assert.equal(server.closes, 1);
});

test('closing during tunnel establishment discards resources that arrive late', async () => {
    const manager = new SSHTunnelManager();
    const entered = deferred<void>();
    const pending = deferred<Client[]>();
    const client = new FakeClient();
    const server = new FakeServer();
    stubTransport(manager).buildConnectionChain = async () => { entered.resolve(); return pending.promise; };
    stubTransport(manager).createForwardingServer = async () => ({ server: server as unknown as Server, localPort: 40000 });
    await manager.register('test', sshConfig);
    const connecting = manager.ensureConnected('test');
    const rejected = assert.rejects(connecting, /closed|cancel/i);
    await entered.promise;
    const closing = manager.closeAll();
    pending.resolve([client as unknown as Client]);
    await Promise.all([rejected, closing]);
    assert.equal(client.closes, 1);
    assert.equal(manager.hasTunnel('test'), false);
    assert.equal(manager.getTunnelInfo('test'), null);
});

test('manual reconnect and first use share pending establishment', async () => {
    const manager = new SSHTunnelManager();
    let builds = 0;
    const client = new FakeClient();
    const server = new FakeServer();
    stubTransport(manager).buildConnectionChain = async () => { builds++; return [client as unknown as Client]; };
    stubTransport(manager).createForwardingServer = async () => ({ server: server as unknown as Server, localPort: 40000 });
    await manager.register('test', sshConfig);
    await Promise.all([manager.ensureConnected('test'), manager.reconnect('test')]);
    await manager.closeAll();
    assert.equal(builds, 1);
    assert.equal(client.closes, 1);
});

test('disconnect while the forwarder is starting cannot publish a healthy tunnel', async () => {
    const manager = new SSHTunnelManager();
    const entered = deferred<void>();
    const pending = deferred<{ server: Server; localPort: number }>();
    const client = new FakeClient();
    const server = new FakeServer();
    stubTransport(manager).buildConnectionChain = async () => [client as unknown as Client];
    stubTransport(manager).createForwardingServer = async () => { entered.resolve(); return pending.promise; };
    await manager.register('test', sshConfig);
    const connecting = manager.ensureConnected('test');
    const rejected = assert.rejects(connecting, /disconnected|closed/i);
    await entered.promise;
    client.emit('close');
    pending.resolve({ server: server as unknown as Server, localPort: 40000 });
    await rejected;
    assert.equal(manager.getTunnelInfo('test'), null);
    assert.equal(client.closes, 1);
    assert.equal(server.closes, 1);
    await manager.closeAll();
});
