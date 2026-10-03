import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/sse.js';

test('parses events split across arbitrary chunks', () => {
    const events = [];
    const parser = createSseParser((e) => events.push(e));

    const stream = 'id: 7\nevent: log\ndata: {"a":1}\n\n: heartbeat\n\nid: 8\r\nevent: log\r\ndata: x\r\ndata: y\r\n\r\n';
    for (const ch of stream) parser.push(ch);

    assert.deepEqual(events, [
        { id: '7', event: 'log', data: '{"a":1}' },
        { id: '8', event: 'log', data: 'x\ny' }
    ]);
});

test('ignores comment-only blocks', () => {
    const events = [];
    const parser = createSseParser((e) => events.push(e));
    parser.push(': heartbeat\n\n: heartbeat\n\n');
    assert.equal(events.length, 0);
});
