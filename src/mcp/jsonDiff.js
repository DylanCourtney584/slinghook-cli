// Compares two requests by meaning rather than by line: JSON key by key, and
// headers by name. Key order and formatting never count as a change.
//
// A copy of the dashboard's frontend/src/lib/support/jsonDiff.js, so compare_events
// reports the same changes the payload diff viewer shows. Keep the two in step.

/** Headers that differ on every delivery, hidden by default when comparing */
export const VOLATILE_HEADERS = new Set([
    'content-length', 'date', 'x-request-id', 'x-amzn-trace-id', 'traceparent', 'tracestate',
    'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-real-ip', 'cf-ray', 'cdn-loop',
    'stripe-signature', 'x-hub-signature', 'x-hub-signature-256', 'x-github-delivery', 'x-shopify-hmac-sha256',
    'x-shopify-webhook-id', 'x-shopify-triggered-at', 'x-slack-signature', 'x-slack-request-timestamp',
    'x-twilio-signature', 'i-twilio-idempotency-token', 'webhook-id', 'webhook-timestamp', 'webhook-signature',
    'svix-id', 'svix-timestamp', 'svix-signature', 'paddle-signature', 'x-slinghook-log-id'
]);

const MAX_CHANGES = 2000;

function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

// Paths in the usual dotted form: data.object.items[0].price, with ["odd key"] when needed
function childPath(path, key) {
    if (typeof key === 'number') return `${path}[${key}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(key)) return path === '' ? key : `${path}.${key}`;
    return `${path}[${JSON.stringify(key)}]`;
}

// Arrays of objects that all carry a unique id are matched by id, so one
// inserted item doesn't show every later item as changed
function idKeyFor(a, b) {
    for (const key of ['id', 'key', 'name']) {
        const all = [...a, ...b];
        if (all.length === 0 || !all.every((v) => typeOf(v) === 'object' && (typeof v[key] === 'string' || typeof v[key] === 'number'))) {
            continue;
        }
        if (new Set(a.map((v) => v[key])).size === a.length && new Set(b.map((v) => v[key])).size === b.length) {
            return key;
        }
    }
    return null;
}

function walk(before, after, path, out) {
    if (out.length >= MAX_CHANGES) return;

    const tb = typeOf(before);
    const ta = typeOf(after);

    if (tb !== ta) {
        out.push({path: path || '(root)', kind: 'changed', before, after});
        return;
    }

    if (tb === 'object') {
        const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const key of keys) {
            const p = childPath(path, key);
            if (!Object.hasOwn(after, key)) out.push({path: p, kind: 'removed', before: before[key]});
            else if (!Object.hasOwn(before, key)) out.push({path: p, kind: 'added', after: after[key]});
            else walk(before[key], after[key], p, out);
        }
        return;
    }

    if (tb === 'array') {
        const idKey = idKeyFor(before, after);
        if (idKey !== null) {
            const prev = new Map(before.map((v) => [v[idKey], v]));
            const next = new Map(after.map((v) => [v[idKey], v]));
            after.forEach((item, i) => {
                const p = `${path}[${idKey}=${JSON.stringify(item[idKey])}]`;
                if (prev.has(item[idKey])) walk(prev.get(item[idKey]), item, p, out);
                else out.push({path: p, kind: 'added', after: item, index: i});
            });
            for (const item of before) {
                if (!next.has(item[idKey])) out.push({path: `${path}[${idKey}=${JSON.stringify(item[idKey])}]`, kind: 'removed', before: item});
            }
            return;
        }
        const len = Math.max(before.length, after.length);
        for (let i = 0; i < len; i++) {
            const p = childPath(path, i);
            if (i >= after.length) out.push({path: p, kind: 'removed', before: before[i]});
            else if (i >= before.length) out.push({path: p, kind: 'added', after: after[i]});
            else walk(before[i], after[i], p, out);
        }
        return;
    }

    if (!Object.is(before, after)) {
        out.push({path: path || '(root)', kind: 'changed', before, after});
    }
}

/**
 * Key-by-key changes from `before` to `after` (both already parsed).
 *
 * @returns {{changes: Array<{path: string, kind: 'added'|'removed'|'changed', before?: any, after?: any}>, truncated: boolean}}
 */
export function diffValues(before, after) {
    const changes = [];
    walk(before, after, '', changes);
    return {changes, truncated: changes.length >= MAX_CHANGES};
}

/**
 * Parses a request body as JSON or a form post; null when it is neither.
 */
export function parseBody(body, contentType = '') {
    if (body === null || body === undefined || body === '') return null;
    if (typeof body === 'object') return body;
    try {
        return JSON.parse(body);
    } catch {
        // fall through
    }
    if (String(contentType).includes('application/x-www-form-urlencoded')) {
        const out = {};
        for (const [k, v] of new URLSearchParams(body)) {
            out[k] = Object.hasOwn(out, k) ? [].concat(out[k], v) : v;
        }
        return out;
    }
    return null;
}

/**
 * Header changes by name (case-insensitive). Volatile headers are left out
 * unless `includeVolatile` is set.
 *
 * @returns {{changes: Array<{path: string, kind: 'added'|'removed'|'changed', before?: string, after?: string}>, same: number, hidden: number}}
 */
export function diffHeaders(before = {}, after = {}, {includeVolatile = false} = {}) {
    const lower = (h) => {
        const out = new Map();
        for (const [k, v] of Object.entries(h ?? {})) out.set(k.toLowerCase(), {name: k, value: Array.isArray(v) ? v.join(', ') : String(v)});
        return out;
    };
    const a = lower(before);
    const b = lower(after);
    const changes = [];
    let same = 0;
    let hidden = 0;

    for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
        const x = a.get(key);
        const y = b.get(key);
        if (x && y && x.value === y.value) {
            same++;
            continue;
        }
        if (!includeVolatile && VOLATILE_HEADERS.has(key)) {
            hidden++;
            continue;
        }
        const name = (y ?? x).name;
        if (!y) changes.push({path: name, kind: 'removed', before: x.value});
        else if (!x) changes.push({path: name, kind: 'added', after: y.value});
        else changes.push({path: name, kind: 'changed', before: x.value, after: y.value});
    }

    return {changes, same, hidden};
}

/** Short one-line rendering of a value for the changes table */
export function preview(value, max = 120) {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
