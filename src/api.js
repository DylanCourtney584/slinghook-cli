export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * Minimal JSON client for the SlingHook API, authenticated by Bearer token
 * or (during login only) a session cookie.
 */
export function createApi({ server, token = null, cookie = null, fetchImpl = fetch }) {
    async function request(method, path, body) {
        const headers = { Accept: 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) headers['Content-Type'] = 'application/json';

        const res = await fetchImpl(server + path, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined
        });

        const text = await res.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = { raw: text };
        }

        if (!res.ok) {
            throw new ApiError(data?.error || `${res.status} ${res.statusText}`, res.status);
        }

        return { data, res };
    }

    return {
        get: (path) => request('GET', path).then((r) => r.data),
        post: (path, body) => request('POST', path, body).then((r) => r.data),
        postRaw: (path, body) => request('POST', path, body)
    };
}
