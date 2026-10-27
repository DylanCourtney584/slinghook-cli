import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommand } from '../src/commands.js';

test('auth subcommands are the same as the bare commands', () => {
    assert.deepEqual(resolveCommand(['auth', 'login']), { command: 'login', args: [] });
    assert.deepEqual(resolveCommand(['auth', 'status']), { command: 'status', args: [] });
    assert.deepEqual(resolveCommand(['login']), { command: 'login', args: [] });
    assert.deepEqual(resolveCommand(['listen', 'abc']), { command: 'listen', args: ['abc'] });
    assert.deepEqual(resolveCommand([]), { command: null, args: [] });
});

test('auth needs a known subcommand', () => {
    assert.throws(() => resolveCommand(['auth']), /shk auth login\|logout\|status/);
    assert.throws(() => resolveCommand(['auth', 'nope']), /Usage/);
});
