import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { listen } from '../src/listen.js';

function startServer(handler) {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const url = (server) => `http://127.0.0.1:${server.address().port}`;

function sse(res, events) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const { id, event, data } of events) {
        res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    res.write(': heartbeat\n\n');
    res.end();
}

const logRow = (id, extra = {}) => ({
    id,
    method: 'POST',
    headers: JSON.stringify({ 'Content-Type': 'application/json', 'X-Github-Event': 'push' }),
    query_params: null,
    body: `{"n":${id}}`,
    content_type: 'application/json',
    is_truncated: 0,
    signature_status: 'valid',
    ...extra
});

test('forwards live events, skips initial history, resumes with Last-Event-ID, and reports', async () => {
    const delivered = [];
    const target = await startServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            delivered.push({ body, event: req.headers['x-github-event'], logId: req.headers['x-slinghook-log-id'] });
            res.writeHead(204).end();
        });
    });

    const connections = [];
    const reports = [];
    const controller = new AbortController();

    const slinghook = await startServer((req, res) => {
        if (req.url.startsWith('/v1/events/')) {
            assert.equal(req.headers.authorization, 'Bearer shk_test');
            connections.push(req.headers['last-event-id'] ?? null);

            if (connections.length === 1) {
                sse(res, [
                    { id: 1, event: 'history', data: logRow(1) },
                    { id: 2, event: 'log', data: logRow(2) },
                    { id: 3, event: 'log', data: logRow(3, { is_truncated: 1 }) }
                ]);
            } else if (connections.length === 2) {
                sse(res, [{ id: 4, event: 'log', data: logRow(4) }]);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                setTimeout(() => controller.abort(), 50);
            }
            return;
        }

        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            reports.push({ path: req.url, ...JSON.parse(body) });
            res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        });
    });

    const silent = { ready() {}, delivered() {}, skipped() {}, warn() {} };

    await listen({
        server: url(slinghook),
        token: 'shk_test',
        endpointUuid: '00000000-0000-4000-8000-000000000000',
        target: `${url(target)}/webhooks`,
        logger: silent,
        signal: controller.signal
    });

    slinghook.close();
    target.close();

    assert.deepEqual(connections, [null, '3', '4']);
    assert.deepEqual(delivered.map((d) => d.body), ['{"n":2}', '{"n":4}']);
    assert.equal(delivered[0].event, 'push');
    assert.equal(delivered[0].logId, '2');
    assert.deepEqual(reports.map((r) => [r.path, r.response_status]), [
        ['/api/logs/2/replays', 204],
        ['/api/logs/4/replays', 204]
    ]);
});

test('fails fast on a revoked token', async () => {
    const slinghook = await startServer((req, res) => res.writeHead(401).end());

    await assert.rejects(
        listen({
            server: url(slinghook),
            token: 'shk_bad',
            endpointUuid: 'x',
            target: 'http://localhost:1/',
            logger: { ready() {}, delivered() {}, skipped() {}, warn() {} }
        }),
        /slinghook login/
    );

    slinghook.close();
});
