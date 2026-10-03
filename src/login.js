import { hostname } from 'node:os';
import { createApi } from './api.js';

/**
 * Exchanges email + password for a long-lived API token.
 *
 * Signs in with a throwaway session, mints a token with it, then signs that
 * session out, so only the token is ever stored.
 */
export async function loginWithPassword({ server, email, password, fetchImpl = fetch }) {
    const anon = createApi({ server, fetchImpl });
    const { res } = await anon.postRaw('/api/login', { email, password });

    const cookie = sessionCookie(res.headers);
    if (!cookie) {
        throw new Error('Login succeeded but the server did not return a session cookie');
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

function sessionCookie(headers) {
    const raw = typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie')].filter(Boolean);

    return raw.map((c) => c.split(';')[0]).join('; ') || null;
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
