import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEndpointRef, resolveEndpointUuid } from '../src/endpoint.js';

const UUID = '4e6acf98-9df8-49bc-8783-45a4d01d4eef';

test('accepts a bare uuid or a catch URL', () => {
    assert.deepEqual(parseEndpointRef(UUID), { uuid: UUID });
    assert.deepEqual(parseEndpointRef(`http://localhost:5173/v1/catch/${UUID}`), { uuid: UUID });
    assert.deepEqual(parseEndpointRef(`https://slinghook.co.za/v1/catch/${UUID.toUpperCase()}/`), { uuid: UUID });
});

test('reads a reserved URL or slug', () => {
    assert.deepEqual(parseEndpointRef('https://slinghook.co.za/v1/catch/stripe-dev'), { slug: 'stripe-dev' });
    assert.deepEqual(parseEndpointRef('stripe-dev'), { slug: 'stripe-dev' });
    assert.throws(() => parseEndpointRef('https://example.com/a/b'), /not an endpoint/);
});

test('looks a slug up in the workspace', async () => {
    const api = { get: async () => ({ endpoints: [{ uuid: UUID, slug: 'stripe-dev' }] }) };
    assert.equal(await resolveEndpointUuid(api, 'https://x/v1/catch/stripe-dev'), UUID);
    await assert.rejects(resolveEndpointUuid(api, 'other'), /No endpoint/);
});
