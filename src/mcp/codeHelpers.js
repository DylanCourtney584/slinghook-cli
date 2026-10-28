// The quoting and request helpers that eventToCode.js uses, copied from the
// dashboard's frontend/src/lib/support/codeGenerators.js and eventRef.js.
// Keep them in step with those files.

const STRIP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);

export function cleanHeaders(headers = {}) {
    const cleaned = {};
    for (const [k, v] of Object.entries(headers)) {
        if (!STRIP_HEADERS.has(k.toLowerCase()) && !k.startsWith(':')) {
            cleaned[k] = v;
        }
    }
    cleaned['X-Webhook-Replay'] = 'true';
    return cleaned;
}

export function buildUrl(baseUrl, queryParams = {}) {
    let url = baseUrl;
    if (queryParams && Object.keys(queryParams).length > 0) {
        const sp = new URLSearchParams(queryParams);
        url += (url.includes('?') ? '&' : '?') + sp.toString();
    }
    return url;
}

function escapePhpString(str) {
    if (!str) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/*
 * Everything below interpolates values a webhook SENDER controls (headers,
 * method, body) into code the developer will paste and run. Every value must
 * go through the quoting helper for its target language.
 */

/** PHP single-quoted literal: only \\ and \' are special inside it */
export function phpQuote(value) {
    return `'${escapePhpString(String(value ?? ''))}'`;
}

/**
 * A JSON string literal is also a valid string literal in JS, Python and Go.
 * U+2028/U+2029 are escaped as well, since older JS engines treat them as
 * line terminators.
 */
export function jsonQuote(value) {
    return JSON.stringify(String(value ?? '')).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** HTTP methods are tokens; anything else is replaced so it can't break out */
export function safeMethod(method) {
    const m = String(method || 'POST').toUpperCase();
    return /^[A-Z][A-Z0-9_-]{0,19}$/.test(m) ? m : 'POST';
}

/** How people name one captured request: its number within the account (#12) */
export function eventRef(log) {
    return log?.number != null ? `#${log.number}` : '';
}
