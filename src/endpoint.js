const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * What the person passed to `listen`: an endpoint uuid, its catch URL
 * (http://host/v1/catch/<uuid>), or a reserved URL or slug (/v1/catch/<slug>).
 *
 * @returns {{uuid: string} | {slug: string}}
 */
export function parseEndpointRef(input) {
    const text = String(input ?? '').trim();
    const uuid = text.match(UUID_RE);
    if (uuid) return { uuid: uuid[0].toLowerCase() };

    let path = text;
    try {
        path = new URL(text).pathname;
    } catch {
        // Not a URL; a bare slug
    }
    const slug = path.replace(/^\/+|\/+$/g, '').replace(/^v1\/catch\//, '');
    if (!slug || slug.includes('/')) {
        throw new Error(`"${text}" is not an endpoint. Pass its UUID or catch URL; run \`slinghook endpoints\` to list yours.`);
    }
    return { slug };
}

/**
 * The endpoint's uuid. A reserved slug is looked up in the workspace.
 */
export async function resolveEndpointUuid(api, input) {
    const ref = parseEndpointRef(input);
    if (ref.uuid) return ref.uuid;

    const { endpoints = [] } = await api.get('/api/endpoints');
    const endpoint = endpoints.find((ep) => ep.slug === ref.slug);
    if (!endpoint) throw new Error(`No endpoint with the URL /v1/catch/${ref.slug} in this workspace.`);
    return endpoint.uuid;
}
