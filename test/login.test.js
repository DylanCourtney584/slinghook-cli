import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginWithPassword, sessionCookie } from '../src/login.js';

const headers = (cookies) => ({ getSetCookie: () => cookies, get: () => null });

test('keeps the last value of a cookie set twice', () => {
    assert.equal(
        sessionCookie(headers(['PHPSESSID=old; path=/; HttpOnly', 'PHPSESSID=new; path=/; HttpOnly'])),
        'PHPSESSID=new'
    );
});

test('updates earlier cookies and drops deleted ones', () => {
    assert.equal(sessionCookie(headers(['PHPSESSID=b; path=/', 'x=deleted; Max-Age=0']), 'PHPSESSID=a; x=1'), 'PHPSESSID=b');
    assert.equal(sessionCookie(headers([]), 'PHPSESSID=a'), 'PHPSESSID=a');
});

function fakeServer(routes) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const path = new URL(url).pathname;
        calls.push({ path, cookie: opts.headers.Cookie ?? null, body: opts.body ? JSON.parse(opts.body) : null });
        const { status = 200, body = {}, cookies = [] } = routes[path](opts);
        return {
            ok: status < 400,
            status,
            statusText: '',
            headers: headers(cookies),
            text: async () => JSON.stringify(body)
        };
    };
    return { calls, fetchImpl };
}

test('mints the token with the renewed session', async () => {
    const { calls, fetchImpl } = fakeServer({
        '/api/login': () => ({ body: { ok: true }, cookies: ['PHPSESSID=first; path=/', 'PHPSESSID=signedin; path=/'] }),
        '/api/tokens': () => ({ status: 201, body: { token: 'shk_abc' } }),
        '/api/logout': () => ({ body: { ok: true } })
    });

    const token = await loginWithPassword({ server: 'http://s', email: 'a@b.c', password: 'pw', fetchImpl });

    assert.equal(token, 'shk_abc');
    assert.equal(calls[1].cookie, 'PHPSESSID=signedin');
});

test('asks for the two-factor code when the account needs one', async () => {
    const { calls, fetchImpl } = fakeServer({
        '/api/login': () => ({ body: { ok: true, two_factor_required: true }, cookies: ['PHPSESSID=pending'] }),
        '/api/login/2fa': () => ({ body: { ok: true }, cookies: ['PHPSESSID=signedin'] }),
        '/api/tokens': () => ({ status: 201, body: { token: 'shk_2fa' } }),
        '/api/logout': () => ({ body: { ok: true } })
    });

    const token = await loginWithPassword({
        server: 'http://s', email: 'a@b.c', password: 'pw', fetchImpl, promptCode: async () => '123 456'
    });

    assert.equal(token, 'shk_2fa');
    assert.deepEqual(calls[1], { path: '/api/login/2fa', cookie: 'PHPSESSID=pending', body: { code: '123456' } });
    assert.equal(calls[2].cookie, 'PHPSESSID=signedin');
});

test('sends anything but six digits as a recovery code', async () => {
    const { calls, fetchImpl } = fakeServer({
        '/api/login': () => ({ body: { two_factor_required: true }, cookies: ['PHPSESSID=p'] }),
        '/api/login/2fa': () => ({ body: { ok: true }, cookies: ['PHPSESSID=s'] }),
        '/api/tokens': () => ({ status: 201, body: { token: 't' } }),
        '/api/logout': () => ({ body: {} })
    });

    await loginWithPassword({ server: 'http://s', email: 'a', password: 'b', fetchImpl, promptCode: async () => 'abcd-efgh' });
    assert.deepEqual(calls[1].body, { recovery_code: 'abcd-efgh' });
});
