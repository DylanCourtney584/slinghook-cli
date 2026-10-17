import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChaos, baselineFailed } from '../src/chaos.js';

const request = {
    id: 7,
    method: 'POST',
    headers: { 'Stripe-Signature': 't=1,v1=abc', 'Content-Type': 'application/json' },
    query_params: {},
    content_type: 'application/json',
    body: '{"id":"evt_1"}'
};

function plan(rounds, checkUrl = null) {
    return {
        run: { id: 3, name: 'Checkout', target_url: 'http://localhost:3000/hook', check_url: checkUrl, rounds },
        requests: { 7: request },
        malformed_bodies: { '7:empty': '' }
    };
}

function fakeApi(created) {
    const calls = [];
    return {
        calls,
        async post(path, body) {
            calls.push({ path, body });
            if (path === '/api/chaos/runs') return created;
            return { run: { ...created.run, status: 'passed', report: { tests: [] }, posted: body } };
        }
    };
}

const accept = { log_id: 7, variant: null, expect: 'accept' };

test('sends every round, concurrent copies at once, and posts the answers', async () => {
    const created = plan([
        { test: 'baseline', delay_ms: 0, shots: [accept] },
        { test: 'concurrent', delay_ms: 0, shots: [accept, accept, accept] },
        { test: 'malformed', delay_ms: 0, shots: [{ log_id: 7, variant: 'empty', expect: 'reject' }] },
        { test: 'late_retry', delay_ms: 5_000, shots: [accept] }
    ], 'http://localhost:3000/orders/count');
    const api = fakeApi(created);

    const sent = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = async (url, init) => {
        if (url.endsWith('/orders/count')) return new Response('{"orders":1}', { status: 200 });
        sent.push({ url, init });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response('ok', { status: init.body === '' ? 400 : 200 });
    };
    const slept = [];

    const run = await runChaos({
        api,
        run: { endpoint: 'uuid', scenario_id: 1, target_url: 'http://localhost:3000/hook' },
        fetchImpl,
        sleep: async (ms) => slept.push(ms)
    });

    assert.equal(api.calls[0].body.source, 'cli');
    assert.equal(sent.length, 6);
    assert.equal(maxInFlight, 3);
    assert.deepEqual(slept, [5_000]);

    // Sent like the provider did: original signature, no replay marker
    const headers = sent[0].init.headers;
    assert.equal(headers['Stripe-Signature'], 't=1,v1=abc');
    assert.equal(headers['X-Webhook-Replay'], undefined);
    assert.equal(sent[4].init.body, '');

    const posted = run.posted;
    assert.deepEqual(posted.results.map((r) => r.map((s) => s.status)), [[200], [200, 200, 200], [400], [200]]);
    assert.deepEqual(Object.keys(posted.probes), ['baseline', 'concurrent', 'malformed', 'late_retry']);
    assert.equal(posted.stopped, false);
});

test('stops after a failed baseline', async () => {
    const created = plan([
        { test: 'baseline', delay_ms: 0, shots: [accept] },
        { test: 'duplicates', delay_ms: 0, shots: [accept] }
    ]);
    const api = fakeApi(created);
    let count = 0;

    const run = await runChaos({
        api,
        run: {},
        fetchImpl: async () => {
            count++;
            return new Response('boom', { status: 500 });
        }
    });

    assert.equal(count, 1);
    assert.equal(run.posted.results.length, 1);
});

test('baselineFailed only looks at baseline rounds', () => {
    const rounds = [{ test: 'baseline' }, { test: 'duplicates' }];
    assert.equal(baselineFailed(rounds, [[{ status: 200 }], [{ status: 500 }]]), false);
    assert.equal(baselineFailed(rounds, [[{ status: null, error: 'refused' }]]), true);
});
