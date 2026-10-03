/**
 * Re-sends a captured webhook to a local target, mirroring the server's
 * replay.php: hop-by-hop headers are dropped and everything else is kept, so
 * signature checks in the app under test still see the original headers.
 */

const STRIP_HEADERS = new Set([
    'host',
    'content-length',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'expect',
    'upgrade',
    'te',
    'trailer',
    'proxy-connection'
]);

const MAX_RESPONSE_BODY = 10_000;

/**
 * @param {object} log      A log row as streamed by /v1/events
 * @param {string} target   e.g. http://localhost:3000/webhooks
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{url: string, status: ?number, body: ?string, error: ?string, durationMs: number}>}
 */
export async function forwardLog(log, target, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
    const url = buildTargetUrl(target, parseJson(log.query_params, {}));
    const method = String(log.method || 'POST').toUpperCase();
    const headers = buildHeaders(parseJson(log.headers, {}), log.content_type, log.id);
    const body = method === 'GET' || method === 'HEAD' ? undefined : (log.body ?? undefined);

    const startedAt = performance.now();
    try {
        const res = await fetchImpl(url, {
            method,
            headers,
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(timeoutMs)
        });
        const text = await res.text();
        return {
            url,
            status: res.status,
            body: text.slice(0, MAX_RESPONSE_BODY),
            error: null,
            durationMs: Math.round(performance.now() - startedAt)
        };
    } catch (err) {
        return {
            url,
            status: null,
            body: null,
            error: describeError(err),
            durationMs: Math.round(performance.now() - startedAt)
        };
    }
}

export function buildHeaders(original, contentType, logId) {
    const headers = {};
    for (const [name, value] of Object.entries(original || {})) {
        if (!STRIP_HEADERS.has(name.toLowerCase())) {
            headers[name] = String(value);
        }
    }

    const hasContentType = Object.keys(headers).some((n) => n.toLowerCase() === 'content-type');
    if (contentType && !hasContentType) {
        headers['Content-Type'] = contentType;
    }

    headers['X-Webhook-Replay'] = 'true';
    headers['X-SlingHook-Log-Id'] = String(logId);
    return headers;
}

/**
 * Appends the captured query string to the target, keeping any query the
 * target URL already has.
 */
export function buildTargetUrl(target, queryParams) {
    const url = new URL(target);
    for (const [key, value] of Object.entries(queryParams || {})) {
        if (Array.isArray(value)) {
            value.forEach((v) => url.searchParams.append(key, String(v)));
        } else if (value !== null && typeof value === 'object') {
            // PHP-style nested params (a[b]=c) are rare in webhooks; keep them as JSON
            url.searchParams.append(key, JSON.stringify(value));
        } else {
            url.searchParams.append(key, String(value ?? ''));
        }
    }
    return url.toString();
}

function parseJson(value, fallback) {
    if (value && typeof value === 'object') return value;
    try {
        return typeof value === 'string' ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function describeError(err) {
    if (err?.name === 'TimeoutError') return 'Timed out waiting for local server';
    const code = err?.cause?.code;
    if (code === 'ECONNREFUSED') return 'Connection refused (is your local server running?)';
    return err?.cause?.message || err?.message || String(err);
}
