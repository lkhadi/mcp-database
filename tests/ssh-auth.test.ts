import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import ssh2, { Client, type ConnectConfig, type ClientChannel } from 'ssh2';
import type { Server } from 'node:net';
import { SSHTunnelManager } from '../src/ssh/tunnel-manager.js';
import { sshConfig, FakeServer } from './helpers/lifecycle.js';

test('forwards each encrypted key passphrase to ssh2 for jump and final hosts', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'mcp-auth-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const hosts = ['jump', 'final'];
    const paths = hosts.map((host) => {
        const { privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: `${host}-temporary-passphrase` },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        const path = join(directory, host);
        writeFileSync(path, privateKey, { mode: 0o600 });
        return path;
    });
    const observed: string[] = [];
    t.mock.method(Client.prototype, 'connect', function (this: Client, options: ConnectConfig) {
        assert.ok(options.privateKey);
        const parsed = ssh2.utils.parseKey(options.privateKey, options.passphrase);
        assert.ok(!(parsed instanceof Error), parsed instanceof Error ? parsed.message : 'key parsed');
        observed.push(options.passphrase!);
        queueMicrotask(() => this.emit('ready'));
        return this;
    });
    const stream = new PassThrough();
    t.after(() => stream.destroy());
    t.mock.method(Client.prototype, 'forwardOut', function (
        this: Client, _sourceHost: string, _sourcePort: number, _host: string, _port: number,
        callback: (error: Error | undefined, stream: ClientChannel) => void
    ) { callback(undefined, stream as unknown as ClientChannel); return this; });
    t.mock.method(Client.prototype, 'end', function (this: Client) { return this; });
    const manager = new SSHTunnelManager();
    (manager as unknown as { createForwardingServer: () => Promise<{ server: Server; localPort: number }> }).createForwardingServer = async () => ({ server: new FakeServer() as unknown as Server, localPort: 40000 });
    t.after(() => manager.closeAll());
    await manager.register('test', {
        ...sshConfig, privateKey: paths[1], passphrase: 'final-temporary-passphrase',
        jumpHosts: [{ host: 'jump.invalid', port: 22, username: 'test', privateKey: paths[0], passphrase: 'jump-temporary-passphrase' }],
    });
    await manager.ensureConnected('test');
    assert.deepEqual(observed, ['jump-temporary-passphrase', 'final-temporary-passphrase']);
});
