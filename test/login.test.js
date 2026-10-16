import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginWithBrowser } from '../src/login.js';

function fakeServer(pollAnswers) {
    const calls = [];
    const fetchImpl = async (url, opts) => {
        const path = new URL(url).pathname;
        const body = opts.body ? JSON.parse(opts.body) : null;
        calls.push({ path, body });

        let status = 200;
        let data;
        if (path === '/api/cli/login/start') {
            data = {
                device_code: 'dev123', user_code: 'BCDF-GHJK', interval: 5, expires_in: 900,
                verification_uri: 'http://s/app/?device', verification_uri_complete: 'http://s/app/?device=BCDF-GHJK'
            };
        } else {
            const next = pollAnswers.shift();
            if (typeof next === 'string') {
                status = 400;
                data = { error: next };
            } else {
                data = next;
            }
        }
        return { ok: status < 400, status, statusText: '', headers: { get: () => null }, text: async () => JSON.stringify(data) };
    };
    return { calls, fetchImpl };
}

test('shows the code, polls until approved, and returns the token', async () => {
    const { calls, fetchImpl } = fakeServer(['authorization_pending', 'slow_down', { token: 'shk_new', user: { email: 'a@b.c' } }]);
    const waits = [];
    let shown = null;

    const result = await loginWithBrowser({
        server: 'http://s',
        fetchImpl,
        onCode: (info) => { shown = info; },
        sleep: async (ms) => { waits.push(ms); }
    });

    assert.deepEqual(result, { token: 'shk_new', email: 'a@b.c' });
    assert.equal(shown.userCode, 'BCDF-GHJK');
    assert.equal(shown.urlWithCode, 'http://s/app/?device=BCDF-GHJK');
    assert.match(calls[0].body.client_name, /^CLI on /);
    assert.deepEqual(calls.slice(1).map((c) => c.body), Array(3).fill({ device_code: 'dev123' }));
    // slow_down adds five seconds to every later wait
    assert.deepEqual(waits, [5000, 5000, 10000]);
});

test('stops when the sign-in is cancelled in the browser', async () => {
    const { fetchImpl } = fakeServer(['access_denied']);
    await assert.rejects(
        loginWithBrowser({ server: 'http://s', fetchImpl, onCode: () => {}, sleep: async () => {} }),
        /cancelled in the browser/
    );
});

test('stops when the code expires', async () => {
    const { fetchImpl } = fakeServer(['expired_token']);
    await assert.rejects(
        loginWithBrowser({ server: 'http://s', fetchImpl, onCode: () => {}, sleep: async () => {} }),
        /expired/
    );
});
