import {buildUrl, cleanHeaders, eventRef, jsonQuote, phpQuote, safeMethod} from './codeHelpers.js';

/*
 * A copy of the dashboard's frontend/src/lib/support/eventToCode.js, for the
 * generate_handler MCP tool. Keep the two in step.
 *
 * Turns a captured event into code a developer keeps: typed models of the
 * payload, a fixture file, and a test that sends the event to their handler.
 *
 * Keys and values come from whoever sent the webhook, so every key that ends
 * up in source code is either checked against an identifier pattern or passed
 * through the target language's quoting helper. Values only ever appear inside
 * quoted literals.
 */

// Signature headers are bound to the original delivery and go stale in minutes,
// so tests leave them out rather than send a signature that will fail
const SIGNATURE_HEADERS = new Set([
    'stripe-signature', 'x-stripe-signature', 'x-hub-signature', 'x-hub-signature-256',
    'x-shopify-hmac-sha256', 'x-slack-signature', 'x-slack-request-timestamp',
    'webhook-signature', 'webhook-id', 'webhook-timestamp', 'svix-signature', 'svix-id', 'svix-timestamp',
    'x-twilio-signature', 'authorization', 'cookie'
]);

// ---------------------------------------------------------------------------
// Payload parsing and naming
// ---------------------------------------------------------------------------

/** The payload as a value, from a JSON or form-encoded body; null otherwise. */
export function parsePayload(log) {
    const body = log?.body ?? '';
    if (body.trim() === '') return null;
    try {
        return JSON.parse(body);
    } catch {
        // fall through to form parsing
    }
    const ct = String(log?.contentType ?? '').toLowerCase();
    if (ct.includes('x-www-form-urlencoded') || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body.trim())) {
        return Object.fromEntries(new URLSearchParams(body.trim()));
    }
    return null;
}

/** "request #12" for generated-code comments */
function sourceOf(log) {
    const ref = eventRef(log);
    return ref ? `request ${ref}` : 'a captured request';
}

/** Event name from the payload or the provider's event header, e.g. "invoice.paid". */
export function eventName(log) {
    const payload = parsePayload(log);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        for (const key of ['type', 'event', 'event_type', 'topic']) {
            if (typeof payload[key] === 'string' && payload[key].trim() !== '') return payload[key].trim();
        }
    }
    const headers = lowerKeys(log?.headers);
    for (const key of ['x-github-event', 'x-shopify-topic', 'x-event-type', 'x-event-key']) {
        if (headers[key]) return String(headers[key]).trim();
    }
    if (payload && typeof payload === 'object' && typeof payload.action === 'string') return payload.action;
    return 'webhook event';
}

/** "invoice.payment_succeeded" -> "InvoicePaymentSucceeded" */
export function pascalCase(text, fallback = 'WebhookEvent') {
    const words = String(text ?? '').match(/[A-Za-z0-9]+/g) ?? [];
    let name = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
    if (name === '') name = fallback;
    if (/^\d/.test(name)) name = 'T' + name;
    return name.slice(0, 64);
}

function camelCase(text, fallback) {
    const p = pascalCase(text, fallback);
    return p[0].toLowerCase() + p.slice(1);
}

function singular(name) {
    if (/ies$/.test(name) && name.length > 4) return name.slice(0, -3) + 'y';
    if (/(ss|us)$/.test(name)) return name;
    if (/s$/.test(name) && name.length > 3) return name.slice(0, -1);
    return name + 'Item';
}

function lowerKeys(obj = {}) {
    const out = {};
    for (const [k, v] of Object.entries(obj ?? {})) out[k.toLowerCase()] = v;
    return out;
}

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------
//
// shape = { kind: 'null' | 'string' | 'integer' | 'number' | 'boolean' }
//       | { kind: 'array', items: shape | null }
//       | { kind: 'object', fields: Map<key, { shape, optional }> }
//       | { kind: 'union', options: shape[] }
// plus `nullable: true` when null was also seen in that position.

export function inferShape(value) {
    if (value === null) return {kind: 'null'};
    if (Array.isArray(value)) {
        let items = null;
        for (const item of value) {
            const s = inferShape(item);
            items = items ? mergeShapes(items, s) : s;
        }
        return {kind: 'array', items};
    }
    switch (typeof value) {
        case 'string':
            return {kind: 'string'};
        case 'boolean':
            return {kind: 'boolean'};
        case 'number':
            return {kind: Number.isInteger(value) ? 'integer' : 'number'};
        case 'object': {
            const fields = new Map();
            for (const [k, v] of Object.entries(value)) fields.set(k, {shape: inferShape(v), optional: false});
            return {kind: 'object', fields};
        }
        default:
            return {kind: 'null'};
    }
}

export function mergeShapes(a, b) {
    if (a.kind === 'null' && b.kind === 'null') return a;
    if (a.kind === 'null') return {...b, nullable: true};
    if (b.kind === 'null') return {...a, nullable: true};

    const nullable = Boolean(a.nullable || b.nullable);
    const numeric = new Set(['integer', 'number']);

    if (a.kind === b.kind && a.kind === 'object') {
        const fields = new Map();
        for (const [k, fa] of a.fields) {
            const fb = b.fields.get(k);
            fields.set(k, fb
                ? {shape: mergeShapes(fa.shape, fb.shape), optional: fa.optional || fb.optional}
                : {...fa, optional: true});
        }
        for (const [k, fb] of b.fields) {
            if (!a.fields.has(k)) fields.set(k, {...fb, optional: true});
        }
        return {kind: 'object', fields, nullable};
    }
    if (a.kind === b.kind && a.kind === 'array') {
        const items = a.items && b.items ? mergeShapes(a.items, b.items) : (a.items ?? b.items);
        return {kind: 'array', items, nullable};
    }
    if (a.kind === b.kind) return {...a, nullable};
    if (numeric.has(a.kind) && numeric.has(b.kind)) return {kind: 'number', nullable};

    // Different kinds: a union, merging into a matching option where one exists
    const options = [...(a.kind === 'union' ? a.options : [a])];
    for (const opt of (b.kind === 'union' ? b.options : [b])) {
        const i = options.findIndex(o => o.kind === opt.kind
            || (numeric.has(o.kind) && numeric.has(opt.kind)));
        if (i === -1) options.push({...opt, nullable: false});
        else options[i] = {...mergeShapes(options[i], opt), nullable: false};
    }
    return {kind: 'union', options, nullable};
}

// Names that clash with a language keyword or built-in type in at least one of
// the target languages. A clashing nested type takes its parent's name as a prefix.
const RESERVED_TYPE_NAMES = new Set(('Object String Number Boolean Bool Int Integer Float Double Array List Mixed '
    + 'Void Null True False Iterable Callable Self Parent Static Class Function Namespace Enum Match Readonly Never '
    + 'Interface Trait Fn Default Switch Case Abstract Final Public Private Protected Include Require Print Echo '
    + 'Date Error Map Set Promise Symbol Record Json Math RegExp Partial Required Any Unknown Type Dict Tuple Bytes '
    + 'Exception Closure Generator Stringable Countable Iterator Traversable Resource Numeric Scalar Global Var Const '
    + 'Use As Instanceof Insteadof Goto Declare Extends Implements New Clone Try Catch Throw Finally Yield Return '
    + 'If Else Elseif While Do For Foreach Break Continue List Isset Unset Empty Eval Exit Die Or And Xor Package '
    + 'Struct Chan Go Defer Select Range Func Rune Byte Error Uintptr Complex Real Imag Len Cap Make Append Copy '
    + 'Delete Panic Recover Close Not Is In Del Pass Lambda Nonlocal Assert Raise With Async Await None Payload').split(' '));

/**
 * Names every object shape, root first, so generators can emit one type per object.
 *
 * @returns {{name: string, shape: object}[]}
 */
function collectTypes(shape, rootName) {
    const types = [];
    const used = new Set();
    const named = new Map();

    const visit = (s, name, parent = '') => {
        if (!s) return;
        if (s.kind === 'object') {
            if (RESERVED_TYPE_NAMES.has(name)) name = (parent || 'Webhook') + name;
            let unique = name;
            for (let i = 2; used.has(unique); i++) unique = `${name}${i}`;
            used.add(unique);
            named.set(s, unique);
            types.push({name: unique, shape: s});
            for (const [key, f] of s.fields) visit(f.shape, pascalCase(key, 'Field'), unique);
        } else if (s.kind === 'array') {
            visit(s.items, singular(name), parent);
        } else if (s.kind === 'union') {
            s.options.forEach(o => visit(o, name, parent));
        }
    };
    visit(shape, rootName);

    return {types, nameOf: s => named.get(s)};
}

function safeRootName(log) {
    const name = pascalCase(eventName(log));
    return RESERVED_TYPE_NAMES.has(name) ? `${name}Event` : name;
}

const JS_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function payloadOrThrow(log) {
    const payload = parsePayload(log);
    if (payload === null) throw new Error('Types can only be generated from a JSON or form-encoded body.');
    return payload;
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

export function generateTypeScript(log) {
    const payload = payloadOrThrow(log);
    const rootName = safeRootName(log);
    const shape = inferShape(payload);
    const {types, nameOf} = collectTypes(shape, rootName);

    const ts = s => {
        if (!s) return 'unknown';
        let t;
        switch (s.kind) {
            case 'null': return 'null';
            case 'string': t = 'string'; break;
            case 'integer':
            case 'number': t = 'number'; break;
            case 'boolean': t = 'boolean'; break;
            case 'object': t = nameOf(s); break;
            case 'array': {
                const inner = ts(s.items);
                t = /[ |]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
                break;
            }
            case 'union': t = s.options.map(ts).join(' | '); break;
        }
        return s.nullable ? `${t} | null` : t;
    };

    const out = [`// Generated by SlingHook from ${sourceOf(log)} (${jsonQuote(eventName(log))})`];
    if (shape.kind !== 'object') out.push(`export type ${rootName} = ${ts(shape)};`);
    for (const {name, shape: s} of types) {
        out.push('', `export interface ${name} {`);
        for (const [key, f] of s.fields) {
            const prop = JS_IDENT.test(key) ? key : jsonQuote(key);
            out.push(`  ${prop}${f.optional ? '?' : ''}: ${ts(f.shape)};`);
        }
        out.push('}');
    }
    return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Python (TypedDict)
// ---------------------------------------------------------------------------

const PY_KEYWORDS = new Set(('False None True and as assert async await break class continue def del elif else '
    + 'except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield')
    .split(' '));

export function generatePythonTypes(log) {
    const payload = payloadOrThrow(log);
    const rootName = safeRootName(log);
    const shape = inferShape(payload);
    const {types, nameOf} = collectTypes(shape, rootName);

    const py = s => {
        if (!s) return 'Any';
        let t;
        switch (s.kind) {
            case 'null': return 'None';
            case 'string': t = 'str'; break;
            case 'integer': t = 'int'; break;
            case 'number': t = 'float'; break;
            case 'boolean': t = 'bool'; break;
            case 'object': t = nameOf(s); break;
            case 'array': t = `list[${py(s.items)}]`; break;
            case 'union': t = s.options.map(py).join(' | '); break;
        }
        return s.nullable ? `${t} | None` : t;
    };

    const out = [
        `# Generated by SlingHook from ${sourceOf(log)}`,
        'from typing import Any, NotRequired, TypedDict',
    ];
    // Children first: the functional TypedDict form evaluates its types at definition time
    for (const {name, shape: s} of [...types].reverse()) {
        const entries = [...s.fields].map(([key, f]) => {
            const t = py(f.shape);
            return {key, type: f.optional ? `NotRequired[${t}]` : t};
        });
        const classSyntax = entries.every(e => /^[A-Za-z_][A-Za-z0-9_]*$/.test(e.key) && !PY_KEYWORDS.has(e.key));
        out.push('', '');
        if (classSyntax) {
            out.push(`class ${name}(TypedDict):`);
            if (entries.length === 0) out.push('    pass');
            for (const e of entries) out.push(`    ${e.key}: ${e.type}`);
        } else {
            out.push(`${name} = TypedDict(${jsonQuote(name)}, {`);
            for (const e of entries) out.push(`    ${jsonQuote(e.key)}: ${e.type},`);
            out.push('})');
        }
    }
    if (shape.kind !== 'object') out.push('', '', `${rootName} = ${py(shape)}`);
    return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// PHP (readonly DTOs with fromArray)
// ---------------------------------------------------------------------------

export function generatePhpDto(log) {
    const payload = payloadOrThrow(log);
    const rootName = safeRootName(log);
    const shape = inferShape(payload);
    if (shape.kind !== 'object') {
        throw new Error('PHP classes need a JSON object at the top level.');
    }
    const {types, nameOf} = collectTypes(shape, rootName);

    const scalar = {string: 'string', integer: 'int', number: 'float', boolean: 'bool'};
    const phpType = s => {
        if (!s || s.kind === 'null') return 'mixed';
        if (s.kind === 'union') {
            if (!s.options.every(o => scalar[o.kind])) return 'mixed';
            const t = [...new Set(s.options.map(o => scalar[o.kind]))].join('|');
            return s.nullable ? `${t}|null` : t;
        }
        const t = s.kind === 'object' ? nameOf(s) : s.kind === 'array' ? 'array' : scalar[s.kind];
        return s.nullable ? `?${t}` : t;
    };
    const docType = s => {
        if (!s || s.kind !== 'array') return null;
        const inner = s.items?.kind === 'object' ? nameOf(s.items) : s.items ? phpType(s.items) : 'mixed';
        return `list<${inner}>`;
    };

    const out = ['<?php', '', 'declare(strict_types=1);', '',
        `// Generated by SlingHook from ${sourceOf(log)}`];

    for (const {name, shape: s} of types) {
        const used = new Set();
        const props = [...s.fields].map(([key, f]) => {
            let prop = camelCase(key, 'field');
            for (let i = 2; used.has(prop); i++) prop = `${camelCase(key, 'field')}${i}`;
            used.add(prop);
            const optional = f.optional || f.shape.nullable || f.shape.kind === 'null';
            let type = phpType(f.shape);
            if (optional && type !== 'mixed' && !type.startsWith('?') && !type.endsWith('|null')) {
                type = type.includes('|') ? `${type}|null` : `?${type}`;
            }
            const access = `$data[${phpQuote(key)}]`;
            let value;
            if (f.shape.kind === 'object') {
                value = optional
                    ? `isset(${access}) ? ${nameOf(f.shape)}::fromArray(${access}) : null`
                    : `${nameOf(f.shape)}::fromArray(${access})`;
            } else if (f.shape.kind === 'array' && f.shape.items?.kind === 'object') {
                value = `array_map(${nameOf(f.shape.items)}::fromArray(...), ${access}${optional ? ' ?? []' : ''})`;
                if (optional && !f.shape.nullable) type = 'array';
            } else {
                value = optional ? `${access} ?? null` : access;
            }
            return {prop, type, value, doc: docType(f.shape)};
        });

        out.push('', `final readonly class ${name}`, '{', '    public function __construct(');
        for (const p of props) {
            if (p.doc) out.push(`        /** @var ${p.doc} */`);
            out.push(`        public ${p.type} $${p.prop},`);
        }
        out.push('    ) {}', '',
            '    /** @param array<string, mixed> $data */',
            '    public static function fromArray(array $data): self',
            '    {',
            '        return new self(');
        for (const p of props) out.push(`            ${p.prop}: ${p.value},`);
        out.push('        );', '    }', '}');
    }
    return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Go (structs with json tags)
// ---------------------------------------------------------------------------

const GO_INITIALISMS = new Set(['id', 'url', 'uri', 'api', 'ip', 'http', 'https', 'json', 'html', 'sku', 'uuid', 'sms']);

function goField(key) {
    const words = String(key).match(/[A-Za-z0-9]+/g) ?? [];
    let name = words
        .map(w => GO_INITIALISMS.has(w.toLowerCase()) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))
        .join('');
    if (name === '') name = 'Field';
    if (/^\d/.test(name)) name = 'F' + name;
    return name;
}

export function generateGoStructs(log) {
    const payload = payloadOrThrow(log);
    const rootName = safeRootName(log);
    const shape = inferShape(payload);
    const {types, nameOf} = collectTypes(shape, rootName);

    const go = (s, pointer = false) => {
        if (!s || s.kind === 'null' || s.kind === 'union') return 'any';
        const base = {
            string: 'string', integer: 'int64', number: 'float64', boolean: 'bool',
        }[s.kind] ?? (s.kind === 'object' ? nameOf(s) : `[]${go(s.items)}`);
        return (pointer || s.nullable) && s.kind !== 'array' ? `*${base}` : base;
    };

    const out = [`// Generated by SlingHook from ${sourceOf(log)}`, 'package webhooks'];
    if (shape.kind !== 'object') out.push('', `type ${rootName} ${go(shape)}`);
    for (const {name, shape: s} of types) {
        out.push('', `type ${name} struct {`);
        const used = new Set();
        let skipped = 0;
        for (const [key, f] of s.fields) {
            // A tag can't safely hold quotes, backticks, backslashes, commas or whitespace
            if (!/^[^"`\\,\s]+$/.test(key)) {
                skipped++;
                continue;
            }
            let field = goField(key);
            for (let i = 2; used.has(field); i++) field = `${goField(key)}${i}`;
            used.add(field);
            const omit = f.optional || f.shape.nullable ? ',omitempty' : '';
            out.push(`\t${field} ${go(f.shape, f.optional)} \`json:"${key}${omit}"\``);
        }
        if (skipped) out.push(`\t// ${skipped} field(s) with names Go tags can't hold were left out`);
        out.push('}');
    }
    return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Fixture and tests
// ---------------------------------------------------------------------------

/** The body as a fixture file: pretty JSON when possible, otherwise the raw bytes. */
export function generateFixture(log) {
    const body = log?.body ?? '';
    try {
        return JSON.stringify(JSON.parse(body), null, 2) + '\n';
    } catch {
        return body;
    }
}

export function fixtureFileName(log) {
    const slug = eventName(log).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'webhook';
    let ext = 'txt';
    try {
        JSON.parse(log?.body ?? '');
        ext = 'json';
    } catch {
        if (/xml/i.test(log?.contentType ?? '')) ext = 'xml';
    }
    return `${slug}.${ext}`;
}

function testHeaders(log) {
    const out = {};
    for (const [k, v] of Object.entries(cleanHeaders(log.headers))) {
        if (!SIGNATURE_HEADERS.has(k.toLowerCase())) out[k] = String(v);
    }
    return out;
}

function hasSignature(log) {
    return Object.keys(log.headers ?? {}).some(k => SIGNATURE_HEADERS.has(k.toLowerCase()) && k.toLowerCase() !== 'cookie');
}

const SIG_NOTE = 'Signature headers were left out because they expire. Skip verification in tests, or sign with your test secret.';

/** The body pretty-printed when it's JSON, so test payloads are easy to read and edit; null otherwise. */
function prettyBody(log) {
    try {
        return JSON.stringify(JSON.parse(log.body ?? ''), null, 2);
    } catch {
        return null;
    }
}

/** A JSON object literal is valid JS once U+2028/U+2029 are escaped. */
function jsLiteral(json) {
    return json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Python triple-quoted string holding JSON text: only backslashes and quote runs need escaping. */
function pyTripleQuoted(json) {
    const body = json.replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
    return `"""\\\n${body}\n"""`;
}

function testSlug(log) {
    return eventName(log).replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase().slice(0, 60) || 'webhook';
}

/** Jest or Vitest (globals), posting the event to the handler with fetch. */
export function generateJsTest(log, targetUrl) {
    const url = buildUrl(targetUrl, log.queryParams);
    const method = safeMethod(log.method);

    const out = [`// Generated by SlingHook from ${sourceOf(log)}. Works with Jest or Vitest globals.`];
    if (hasSignature(log)) out.push(`// ${SIG_NOTE}`);
    const pretty = prettyBody(log);
    out.push(
        pretty !== null
            ? `const payload = JSON.stringify(${jsLiteral(pretty)});`
            : `const payload = ${jsonQuote(log.body ?? '')};`,
        '',
        `test(${jsonQuote(`handles ${eventName(log)}`)}, async () => {`,
        `  const response = await fetch(${jsonQuote(url)}, {`,
        `    method: ${jsonQuote(method)},`,
        '    headers: {',
        ...Object.entries(testHeaders(log)).map(([k, v]) => `      ${jsonQuote(k)}: ${jsonQuote(v)},`),
        '    },',
    );
    if (method !== 'GET') out.push('    body: payload,');
    out.push(
        '  });',
        '',
        '  expect(response.status).toBeGreaterThanOrEqual(200);',
        '  expect(response.status).toBeLessThan(300);',
        '});',
    );
    return out.join('\n') + '\n';
}

/** pytest with requests. */
export function generatePytest(log, targetUrl) {
    const url = buildUrl(targetUrl, log.queryParams);
    const method = safeMethod(log.method);

    const out = [`# Generated by SlingHook from ${sourceOf(log)}`];
    if (hasSignature(log)) out.push(`# ${SIG_NOTE}`);
    const pretty = prettyBody(log);
    out.push(
        ...(pretty !== null ? ['import json'] : []),
        'import requests',
        '',
        pretty !== null
            ? `PAYLOAD = json.dumps(json.loads(${pyTripleQuoted(pretty)}))`
            : `PAYLOAD = ${jsonQuote(log.body ?? '')}`,
        '',
        '',
        `def test_handles_${testSlug(log)}():`,
        '    response = requests.request(',
        `        ${jsonQuote(method)},`,
        `        ${jsonQuote(url)},`,
        '        headers={',
        ...Object.entries(testHeaders(log)).map(([k, v]) => `            ${jsonQuote(k)}: ${jsonQuote(v)},`),
        '        },',
    );
    if (method !== 'GET') out.push('        data=PAYLOAD.encode("utf-8"),');
    out.push(
        '        timeout=10,',
        '    )',
        '',
        '    assert 200 <= response.status_code < 300',
    );
    return out.join('\n') + '\n';
}

/** PHPUnit feature test for Laravel, which most PHP webhook handlers run on. */
export function generateLaravelTest(log, targetUrl) {
    let path = '/webhook';
    try {
        const u = new URL(buildUrl(targetUrl, log.queryParams));
        path = u.pathname + u.search;
    } catch {
        // keep the default path
    }
    const method = safeMethod(log.method).toLowerCase();
    const call = ['get', 'post', 'put', 'patch', 'delete'].includes(method) ? method : 'post';
    const headers = testHeaders(log);
    const cls = pascalCase(eventName(log)) + 'WebhookTest';

    const headerArray = Object.entries(headers)
        .map(([k, v]) => `            ${phpQuote(k)} => ${phpQuote(v)},`);
    const pretty = prettyBody(log);
    const isJson = pretty !== null;

    const request = isJson
        ? [`        $response = $this->${call}Json(${phpQuote(path)}, json_decode(self::PAYLOAD, true), [`,
            ...headerArray, '        ]);']
        : [`        $response = $this->call(${phpQuote(safeMethod(log.method))}, ${phpQuote(path)}, [], [], [], $this->transformHeadersToServerVars([`,
            ...headerArray, '        ]), self::PAYLOAD);'];

    return [
        '<?php',
        '',
        'namespace Tests\\Feature;',
        '',
        'use Tests\\TestCase;',
        '',
        `// Generated by SlingHook from ${sourceOf(log)}`,
        ...(hasSignature(log) ? [`// ${SIG_NOTE}`] : []),
        `class ${cls} extends TestCase`,
        '{',
        // A pretty JSON line never starts with "JSON", so the nowdoc can't end early
        ...(isJson
            ? ["    private const PAYLOAD = <<<'JSON'", ...pretty.split('\n').map(l => '        ' + l), '        JSON;']
            : [`    private const PAYLOAD = ${phpQuote(log.body ?? '')};`]),
        '',
        `    public function test_handles_${testSlug(log)}(): void`,
        '    {',
        ...request,
        '',
        '        $response->assertSuccessful();',
        '    }',
        '}',
        ''
    ].join('\n');
}
