import { hostname } from 'node:os';
import { createApi } from './api.js';

/**
 * Exchanges email + password for a long-lived API token.
 *
 * Signs in with a throwaway session, mints a token with it, then signs that
 * session out, so only the token is ever stored. With two-factor sign-in on,
 * `promptCode` is asked for the authenticator (or recovery) code.
 */
export async function loginWithPassword({ server, email, password, promptCode, fetchImpl = fetch }) {
    const anon = createApi({ server, fetchImpl });
    const { data, res } = await anon.postRaw('/api/login', { email, password });

    let cookie = sessionCookie(res.headers);
    if (!cookie) {
        throw new Error('Login succeeded but the server did not return a session cookie');
    }

    if (data?.two_factor_required) {
        if (!promptCode) throw new Error('This account uses two-factor sign-in; pass --token instead');
        const code = String(await promptCode()).replace(/\s+/g, '');
        // Six digits is an authenticator code; anything else is a recovery code
        const body = /^\d{6}$/.test(code) ? { code } : { recovery_code: code };
        const verified = await createApi({ server, cookie, fetchImpl }).postRaw('/api/login/2fa', body);
        cookie = sessionCookie(verified.res.headers, cookie) ?? cookie;
    }

    const session = createApi({ server, cookie, fetchImpl });
    const created = await session.post('/api/tokens', { name: `CLI on ${hostname()}` });
    await session.post('/api/logout').catch(() => {});

    return created.token;
}

export async function verifyToken({ server, token, fetchImpl = fetch }) {
    const data = await createApi({ server, token, fetchImpl }).get('/api/me');
    return data?.user ?? null;
}

/**
 * The Cookie header to send back, from a response's Set-Cookie headers.
 *
 * Each sign-in step renews the session id, so later responses replace
 * cookies from earlier ones; like a browser, keep the last value of each name.
 */
export function sessionCookie(headers, previous = null) {
    const raw = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);
    if (raw.length === 0) return previous;

    const jar = new Map();
    for (const pair of (previous ?? '').split('; ').filter(Boolean)) {
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    for (const cookie of raw) {
        const pair = cookie.split(';')[0].trim();
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        // An expired or emptied cookie is the server deleting it
        if (value === '' || value === 'deleted' || /;\s*max-age=0\b/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
    }

    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ') || null;
}

/**
 * Reads a line from the terminal without echoing it.
 */
export function promptHidden(question) {
    return new Promise((resolve, reject) => {
        const { stdin, stdout } = process;
        if (!stdin.isTTY) {
            reject(new Error('No TTY for password input; pass --token instead'));
            return;
        }

        stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let value = '';
        const onData = (ch) => {
            if (ch === '\r' || ch === '\n' || ch === '\u0004') {
                cleanup();
                stdout.write('\n');
                resolve(value);
            } else if (ch === '\u0003') {
                cleanup();
                stdout.write('\n');
                process.exit(130);
            } else if (ch === '\u007f' || ch === '\b') {
                value = value.slice(0, -1);
            } else {
                value += ch;
            }
        };
        const cleanup = () => {
            stdin.off('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
        };
        stdin.on('data', onData);
    });
}
