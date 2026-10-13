import { createSseParser } from './sse.js';
import { forwardLog, isRetryable } from './forward.js';
import { createApi } from './api.js';

const MAX_BACKOFF_MS = 30_000;

/**
 * Subscribes to an endpoint's event stream and forwards each new webhook to
 * `target`, one at a time and in arrival order.
 *
 * The server closes the stream every ~55s by design; we reconnect with
 * Last-Event-ID so nothing is missed or duplicated across reconnects.
 *
 * @param {object} opts
 * @param {string} opts.server
 * @param {string} opts.token
 * @param {string} opts.endpointUuid
 * @param {string} opts.target
 * @param {boolean} [opts.report=true]   Record each delivery in the dashboard's replay history
 * @param {number} [opts.retries=3]      Extra tries when the local server is down or answers 5xx
 * @param {number} [opts.retryBaseMs=1000] First retry wait; each later wait doubles (max 30s)
 * @param {object} [opts.logger]
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function listen({
    server,
    token,
    endpointUuid,
    target,
    report = true,
    retries = 3,
    retryBaseMs = 1_000,
    logger = consoleLogger(),
    signal,
    fetchImpl = fetch
}) {
    const api = createApi({ server, token, fetchImpl });
    const queue = createQueue();

    let lastEventId = null;
    // On the very first connection the server replays recent history; we skip
    // it. After that, Last-Event-ID suppresses history, except when the stream
    // was empty (no id yet) — then anything arriving is genuinely new.
    let primed = false;
    let backoffMs = 1_000;

    while (!signal?.aborted) {
        let res;
        try {
            const headers = { Accept: 'text/event-stream', Authorization: `Bearer ${token}` };
            if (lastEventId) headers['Last-Event-ID'] = lastEventId;

            res = await fetchImpl(`${server}/v1/events/${endpointUuid}`, { headers, signal });
        } catch (err) {
            if (signal?.aborted) break;
            logger.warn(`Connection failed: ${err.cause?.message || err.message}. Retrying in ${backoffMs / 1000}s`);
            await sleep(backoffMs, signal);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            continue;
        }

        if (res.status === 401) {
            throw new Error('Not authorized. Run `slinghook login` to get a new token.');
        }
        if (res.status === 403 || res.status === 400) {
            throw new Error(`Endpoint ${endpointUuid} was not found on your account.`);
        }
        if (!res.ok || !res.body) {
            logger.warn(`Stream returned HTTP ${res.status}. Retrying in ${backoffMs / 1000}s`);
            await sleep(backoffMs, signal);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
            continue;
        }

        if (!primed) {
            logger.ready(endpointUuid, target);
        }
        backoffMs = 1_000;

        const isFirstConnection = !primed;
        primed = true;

        const parser = createSseParser((evt) => {
            if (evt.id) lastEventId = evt.id;
            if (evt.event === 'history' && isFirstConnection) return;
            if (evt.event !== 'log' && evt.event !== 'history') return;

            let log;
            try {
                log = JSON.parse(evt.data);
            } catch {
                logger.warn(`Skipping unparseable event ${evt.id}`);
                return;
            }
            queue.push(() => deliver(log));
        });

        try {
            const decoder = new TextDecoder();
            for await (const chunk of res.body) {
                parser.push(decoder.decode(chunk, { stream: true }));
            }
        } catch (err) {
            if (signal?.aborted) break;
            logger.warn(`Stream interrupted: ${err.message}. Reconnecting`);
        }
    }

    await queue.idle();

    async function deliver(log) {
        if (Number(log.is_truncated) === 1) {
            logger.skipped(log, 'payload was truncated at capture time');
            return;
        }

        // Later events wait while one retries, so the app still sees them in order
        for (let attempt = 1; ; attempt++) {
            const result = await forwardLog(log, target, { fetchImpl });
            logger.delivered(log, result);
            await record(log, result);

            if (!isRetryable(result) || attempt > retries || signal?.aborted) return;

            const waitMs = Math.min(retryBaseMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
            logger.retrying?.(log, waitMs, attempt + 1, retries + 1);
            await sleep(waitMs, signal);
            if (signal?.aborted) return;
        }
    }

    async function record(log, result) {
        if (!report) return;
        try {
            await api.post(`/api/logs/${log.id}/replays`, {
                target_url: result.url,
                response_status: result.status,
                response_body: result.body,
                error_message: result.error,
                duration_ms: result.durationMs
            });
        } catch (err) {
            logger.warn(`Could not record delivery #${log.id} in history: ${err.message}`);
        }
    }
}

function createQueue() {
    let tail = Promise.resolve();
    return {
        push(task) {
            tail = tail.then(task).catch(() => {});
        },
        idle: () => tail
    };
}

function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

export function consoleLogger() {
    const time = () => dim(new Date().toLocaleTimeString());

    return {
        ready(uuid, target) {
            console.log(`${cyan('●')} Listening on endpoint ${uuid}`);
            console.log(`  Forwarding to ${target}`);
            console.log(dim('  Press Ctrl+C to stop\n'));
        },
        delivered(log, result) {
            const method = String(log.method).padEnd(6);
            const sig = log.signature_status && log.signature_status !== 'unverified'
                ? dim(` sig:${log.signature_status}`)
                : '';
            const outcome = result.error
                ? red(`✗ ${result.error}`)
                : (result.status < 400 ? green : result.status < 500 ? yellow : red)(String(result.status));
            console.log(`${time()} ${method} #${log.id} → ${outcome} ${dim(`${result.durationMs}ms`)}${sig}`);
        },
        retrying(log, waitMs, nextAttempt, maxAttempts) {
            console.log(dim(`         #${log.id} retrying in ${waitMs / 1000}s (try ${nextAttempt} of ${maxAttempts})`));
        },
        skipped(log, reason) {
            console.log(`${time()} ${String(log.method).padEnd(6)} #${log.id} ${yellow(`skipped: ${reason}`)}`);
        },
        warn(message) {
            console.error(`${time()} ${yellow('!')} ${message}`);
        }
    };
}
