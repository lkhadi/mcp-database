import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from 'ssh2';
import type { Server } from 'node:net';
import { SSHTunnelManager } from '../src/ssh/tunnel-manager.js';
import { FakeClient, FakeServer, sshConfig } from './helpers/lifecycle.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(failures: number) {
    const manager = new SSHTunnelManager();
    const clients: FakeClient[] = [];
    let attempts = 0;
    const mutable = manager as unknown as {
        buildConnectionChain: () => Promise<Client[]>;
        createForwardingServer: () => Promise<{ server: Server; localPort: number }>;
    };
    mutable.buildConnectionChain = async () => {
        attempts++;
        if (attempts > 1 && attempts <= failures + 1) throw new Error('temporary outage');
        const client = new FakeClient(); clients.push(client); return [client as unknown as Client];
    };
    mutable.createForwardingServer = async () => ({ server: new FakeServer() as unknown as Server, localPort: 40000 + attempts });
    await manager.register('test', sshConfig);
    await manager.ensureConnected('test');
    return { manager, clients, get attempts() { return attempts; } };
}

test('automatic reconnect backs off across failures and stops on success', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(2);
    t.after(() => f.manager.closeAll());
    f.clients[0].emit('end');
    f.clients[0].emit('close');
    await flush();
    for (const [delay, expected] of [[1000, 2], [2000, 3], [4000, 4]]) {
        t.mock.timers.tick(delay - 1);
        await flush();
        assert.equal(f.attempts, expected - 1);
        t.mock.timers.tick(1);
        await flush();
        assert.equal(f.attempts, expected);
    }
    assert.equal(f.manager.getTunnelInfo('test')?.isConnected, true);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(f.attempts, 4);
});

test('automatic reconnect makes exactly five attempts after a disconnect', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(Infinity);
    t.after(() => f.manager.closeAll());
    f.clients[0].emit('close');
    await flush();
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
        t.mock.timers.tick(delay);
        await flush();
    }
    assert.equal(f.attempts, 6, 'initial connection plus five reconnect attempts');
    assert.notEqual(f.manager.getTunnelInfo('test')?.isConnected, true);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(f.attempts, 6);
});

test('manual recovery and ensureConnected join automatic backoff', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(0);
    t.after(() => f.manager.closeAll());
    f.clients[0].emit('close');
    await flush();
    const manual = f.manager.reconnect('test');
    const request = f.manager.ensureConnected('test');
    await flush();
    assert.equal(f.attempts, 1, 'no parallel immediate reconnect');
    t.mock.timers.tick(1000);
    const [a, b] = await Promise.all([manual, request]);
    assert.equal(a, b);
    assert.equal(f.attempts, 2);
});

test('shutdown cancels backoff and rejects callers waiting on recovery', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = await fixture(0);
    f.clients[0].emit('close');
    await flush();
    const request = f.manager.ensureConnected('test');
    const rejected = assert.rejects(request, /closed|cancel/i);
    await f.manager.closeAll();
    await rejected;
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(f.attempts, 1);
    assert.equal(f.manager.hasTunnel('test'), false);
});
