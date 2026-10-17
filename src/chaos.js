import { forwardLog } from './forward.js';

/**
 * `slinghook chaos`: asks the server for a chaos plan (see the backend's
 * ChaosPlan), sends every round from this machine so a localhost handler can
 * be tested, then posts the answers back for the server to judge.
 *
 * Every round after the baseline re-sends events the handler has already
 * handled. A concurrent round sends its copies at the same moment. When a
 * check URL is given it is read after each test, so the report can tell
 * whether the redeliveries changed the app's state.
 *
 * @param {object} opts
 * @param {ReturnType<import('./api.js').createApi>} opts.api
 * @param {object} opts.run                  POST /api/chaos/runs body (endpoint, scenario_id|log_id, target_url, ...)
 * @param {object} [opts.logger]
 * @param {AbortSignal} [opts.signal]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [opts.sleep]
 * @returns {Promise<object>} The finished run, with its report
 */
export async function runChaos({ api, run: options, logger = silentLogger(), signal, fetchImpl = fetch, sleep = defaultSleep }) {
    const { run, requests, malformed_bodies: malformedBodies = {} } = await api.post('/api/chaos/runs', {
        ...options,
        source: 'cli'
    });
    logger.started?.(run);

    const results = [];
    const probes = {};
    let stopped = false;

    for (const [i, round] of run.rounds.entries()) {
        if (signal?.aborted) {
            stopped = true;
            break;
        }
        if (round.delay_ms > 0) {
            logger.waiting?.(round, round.delay_ms);
            await sleep(round.delay_ms, signal);
            if (signal?.aborted) {
                stopped = true;
                break;
            }
        }

        const answers = await Promise.all(round.shots.map((shot) => {
            const request = requests[shot.log_id];
            if (!request) return Promise.resolve({ status: null, error: 'The captured request was deleted', durationMs: 0 });
            const log = shot.variant ? { ...request, body: malformedBodies[`${shot.log_id}:${shot.variant}`] ?? '' } : request;
            return forwardLog(log, run.target_url, { markReplay: false, fetchImpl });
        }));
        results.push(answers.map((a) => ({ status: a.status, error: a.error, duration_ms: a.durationMs })));
        logger.round?.(i, round, answers);

        const endsTest = run.rounds[i + 1]?.test !== round.test;
        if (run.check_url && endsTest) {
            probes[round.test] = await probe(run.check_url, fetchImpl);
        }

        // The handler must take the original deliveries before the chaos means anything
        if (endsTest && round.test === 'baseline' && baselineFailed(run.rounds, results)) break;
    }

    const { run: finished } = await api.post(`/api/chaos/runs/${run.id}/report`, { results, probes, stopped });
    return finished;
}

export function baselineFailed(rounds, results) {
    return rounds.some((round, i) => round.test === 'baseline'
        && (results[i] ?? []).some((r) => !(r.status >= 200 && r.status < 300)));
}

/** GET the app's check URL; its answer is compared before and after each test */
export async function probe(url, fetchImpl = fetch) {
    try {
        const res = await fetchImpl(url, {
            headers: { Accept: 'application/json, text/plain, */*', 'X-SlingHook-Chaos-Check': 'true' },
            redirect: 'manual',
            signal: AbortSignal.timeout(10_000)
        });
        return { status: res.status, body: (await res.text()).slice(0, 2_000), error: null };
    } catch (err) {
        return { status: null, body: null, error: err?.cause?.message || err?.message || 'Check URL failed' };
    }
}

function defaultSleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

function silentLogger() {
    return {};
}
