import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaim, saveClaim, describeClaim } from '../src/claims.js';

test('parses body, header and query claims', () => {
    assert.deepEqual(parseClaim('data.object.metadata.dev=alice'), { source: 'body', field: 'data.object.metadata.dev', op: 'equals', value: 'alice' });
    assert.deepEqual(parseClaim('header:X-Dev=alice'), { source: 'header', field: 'X-Dev', op: 'equals', value: 'alice' });
    assert.deepEqual(parseClaim('query:dev = bob'), { source: 'query', field: 'dev', op: 'equals', value: 'bob' });
    assert.deepEqual(parseClaim('header:X-Alice'), { source: 'header', field: 'X-Alice', op: 'exists', value: '' });
});

test('an unknown prefix is part of the body path', () => {
    assert.deepEqual(parseClaim('meta:dev=x'), { source: 'body', field: 'meta:dev', op: 'equals', value: 'x' });
});

test('rejects a claim with no field', () => {
    assert.throws(() => parseClaim('=alice'), /names no field/);
    assert.throws(() => parseClaim('header:'), /names no field/);
});

test('saves the claim on the endpoint with that uuid', async () => {
    const calls = [];
    const api = {
        get: async (path) => {
            calls.push(['GET', path]);
            return { endpoints: [{ id: 3, uuid: 'aaa' }, { id: 8, uuid: 'bbb' }] };
        },
        put: async (path, body) => {
            calls.push(['PUT', path, body]);
            return {};
        }
    };
    const conditions = [parseClaim('dev=alice')];

    await saveClaim(api, 'bbb', conditions);
    assert.deepEqual(calls, [['GET', '/api/endpoints'], ['PUT', '/api/endpoints/8/routing/claims/me', { conditions }]]);

    await assert.rejects(saveClaim(api, 'zzz', conditions), /was not found/);
});

test('describes claims in one line', () => {
    assert.equal(describeClaim([parseClaim('dev=alice'), parseClaim('header:X-Env')]), 'body dev = alice and header X-Env exists');
});
