import { EventEmitter } from 'node:events';
import type { SSHConfig } from '../../src/config/schema.js';

export function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

export const sshConfig: SSHConfig = {
    enabled: true, lazy: true, host: 'ssh.invalid', port: 22, username: 'test',
    targetHost: 'db.invalid', targetPort: 3306,
};

export class FakeClient extends EventEmitter {
    closes = 0;
    end() { this.closes++; }
}

export class FakeServer {
    closes = 0;
    close() { this.closes++; }
}
