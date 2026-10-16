const SOURCES = ['body', 'header', 'query'];

/**
 * Turns a --claim value into a team routing condition (see the backend's
 * RequestRules). The source defaults to the JSON body:
 *
 *   data.object.metadata.dev=alice   body field equals alice
 *   header:X-Dev=alice               header equals alice
 *   query:dev=alice                  query parameter equals alice
 *   header:X-Alice                   header exists
 */
export function parseClaim(spec) {
    const text = String(spec ?? '').trim();
    let source = 'body';
    let rest = text;

    const prefix = /^([a-z]+):(.*)$/i.exec(text);
    if (prefix && SOURCES.includes(prefix[1].toLowerCase())) {
        source = prefix[1].toLowerCase();
        rest = prefix[2];
    }

    const eq = rest.indexOf('=');
    const field = (eq === -1 ? rest : rest.slice(0, eq)).trim();
    if (field === '') {
        throw new Error(`--claim "${text}" names no field. Use e.g. --claim data.object.metadata.dev=alice or --claim header:X-Dev=alice`);
    }

    return eq === -1
        ? { source, field, op: 'exists', value: '' }
        : { source, field, op: 'equals', value: rest.slice(eq + 1).trim() };
}

/**
 * Saves the signed-in person's claim on an endpoint, replacing any earlier one.
 */
export async function saveClaim(api, endpointUuid, conditions) {
    const { endpoints = [] } = await api.get('/api/endpoints');
    const endpoint = endpoints.find((ep) => ep.uuid === endpointUuid);
    if (!endpoint) throw new Error(`Endpoint ${endpointUuid} was not found in this workspace.`);

    await api.put(`/api/endpoints/${endpoint.id}/routing/claims/me`, { conditions });
}

/** One-line summary, e.g. `body data.object.metadata.dev = alice` */
export function describeClaim(conditions) {
    return conditions
        .map((c) => (c.op === 'exists' ? `${c.source} ${c.field} exists` : `${c.source} ${c.field} = ${c.value}`))
        .join(' and ');
}
