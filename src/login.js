import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createApi } from './api.js';

/**
 * Browser sign-in, like `gh auth login --web`: the server issues a one-time
 * code, the person approves it in the dashboard (signing in however they
 * normally do, 2FA included), and polling then returns a new API token.
 *
 * @param {object} opts
 * @param {(info: {userCode: string, url: string, urlWithCode: string}) => Promise<void>|void} opts.onCode
 *        Show the code and open the browser
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 */
export async function loginWithBrowser({ server, onCode, fetchImpl = fetch, sleep = defaultSleep }) {
    const api = createApi({ server, fetchImpl });
    const start = await api.post('/api/cli/login/start', { client_name: `CLI on ${hostname()}` });

    await onCode({
        userCode: start.user_code,
        url: start.verification_uri,
        urlWithCode: start.verification_uri_complete ?? start.verification_uri
    });

    let intervalMs = Math.max(1, Number(start.interval) || 5) * 1000;
    const deadline = Date.now() + (Number(start.expires_in) || 900) * 1000;

    while (Date.now() < deadline) {
        await sleep(intervalMs);
        try {
            const done = await api.post('/api/cli/login/poll', { device_code: start.device_code });
            return { token: done.token, email: done.user?.email ?? null };
        } catch (err) {
            if (err.message === 'authorization_pending') continue;
            if (err.message === 'slow_down') {
                intervalMs += 5000;
                continue;
            }
            if (err.message === 'access_denied') throw new Error('The sign-in was cancelled in the browser.');
            if (err.message === 'expired_token') throw new Error('The code expired. Run `slinghook login` again.');
            if (err.message === 'token_limit') throw new Error('You have too many API tokens. Revoke an unused one under User Settings > API Tokens.');
            throw err;
        }
    }

    throw new Error('The code expired. Run `slinghook login` again.');
}

/**
 * Opens a URL in the default browser. Returns false when that isn't possible
 * (no desktop, e.g. over SSH), so the caller can just print the link.
 */
export function openBrowser(url) {
    const [command, args] = process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
            ? ['open', [url]]
            : ['xdg-open', [url]];

    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyToken({ server, token, fetchImpl = fetch }) {
    const data = await createApi({ server, token, fetchImpl }).get('/api/me');
    return data?.user ?? null;
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
