import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeaders, buildTargetUrl, forwardLog } from '../src/forward.js';

test('drops hop-by-hop headers and keeps signature headers', () => {
    const headers = buildHeaders(
        { Host: 'slinghook.dev', 'Content-Length': '12', Connection: 'close', 'Stripe-Signature': 't=1,v1=abc' },
        'application/json',
        42
    );

    assert.equal(headers.Host, undefined);
    assert.equal(headers['Content-Length'], undefined);
    assert.equal(headers['Stripe-Signature'], 't=1,v1=abc');
    assert.equal(headers['Content-Type'], 'application/json');
    assert.equal(headers['X-SlingHook-Log-Id'], '42');
});

test('appends captured query params to the target', () => {
    const url = buildTargetUrl('http://localhost:3000/hook?keep=1', { topic: 'orders', ids: ['1', '2'] });
    assert.equal(url, 'http://localhost:3000/hook?keep=1&topic=orders&ids=1&ids=2');
});

test('reports connection errors instead of throwing', async () => {
    const fetchImpl = async () => {
        const err = new TypeError('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
    };

    const result = await forwardLog({ id: 1, method: 'POST', body: '{}' }, 'http://localhost:9/hook', { fetchImpl });

    assert.equal(result.status, null);
    assert.match(result.error, /Connection refused/);
});
