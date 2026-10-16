#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig, stripTrailingSlash } from '../src/config.js';
import { loginWithBrowser, openBrowser, verifyToken, promptHidden } from '../src/login.js';
import { listen } from '../src/listen.js';
import { createApi } from '../src/api.js';
import { parseClaim, saveClaim, describeClaim } from '../src/claims.js';

const HELP = `slinghook — forward SlingHook webhooks to your local server

Usage:
  slinghook login [--server URL] [--web | --with-token | --token shk_...]
  slinghook status
  slinghook endpoints
  slinghook listen <endpoint-uuid> --forward <url> [--retries N] [--no-report]
                   [--mine] [--claim FIELD=VALUE ...]
  slinghook logout

Options:
  --server URL     SlingHook server (default: saved config or http://127.0.0.1:8080)
  --web            Log in with your browser (skips the question)
  --with-token     Read a personal access token from standard input, e.g.
                   slinghook login --with-token < token.txt
  --token TOKEN    Log in with this personal access token
  --forward URL    Local URL to deliver webhooks to, e.g. http://localhost:3000/webhooks
  --retries N      Extra tries when your local server is down or answers 5xx
                   (default 3, waiting 1s, 2s, 4s; 0 turns retries off)
  --no-report      Don't record deliveries in the dashboard's replay history
  --mine           Team routing (Team plan): forward only the events routed to
                   you, and count you as online for "whoever is online"
  --claim SPEC     Save your claim on this endpoint first (implies --mine).
                   SPEC is a body path, header: or query: then =value, e.g.
                   data.object.metadata.dev=alice or header:X-Dev=alice.
                   Repeat it to require several conditions.

Environment:
  SLINGHOOK_SERVER, SLINGHOOK_TOKEN override the saved config.
`;

async function main(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            server: { type: 'string' },
            token: { type: 'string' },
            web: { type: 'boolean', default: false },
            'with-token': { type: 'boolean', default: false },
            forward: { type: 'string', short: 'f' },
            'no-report': { type: 'boolean', default: false },
            retries: { type: 'string' },
            mine: { type: 'boolean', default: false },
            claim: { type: 'string', multiple: true },
            help: { type: 'boolean', short: 'h' }
        }
    });

    const [command, ...rest] = positionals;
    const config = loadConfig();
    if (values.server) config.server = stripTrailingSlash(values.server);

    if (values.help || !command) {
        console.log(HELP);
        return;
    }

    switch (command) {
        case 'login':
            return login(config, values);
        case 'status':
            return status(config);
        case 'logout':
            saveConfig({ server: config.server });
            console.log('Removed saved token. Revoke it on the server if it may have leaked.');
            return;
        case 'endpoints':
            return listEndpoints(requireToken(config));
        case 'listen':
            return runListen(requireToken(config), rest[0], values);
        default:
            throw new Error(`Unknown command "${command}". Run slinghook --help`);
    }
}

async function login(config, values) {
    let token = values.token ?? null;
    let method = token ? 'token' : values['with-token'] ? 'stdin' : values.web ? 'web' : null;

    if (!method) {
        if (!process.stdin.isTTY) {
            throw new Error('No terminal to ask in. Use --with-token (reads standard input), --token or --web.');
        }
        console.log(`Logging in to ${config.server}`);
        method = await choose('How would you like to authenticate?', [
            ['web', 'Login with a web browser'],
            ['paste', 'Paste a personal access token']
        ]);
    }

    let email = null;
    if (method === 'web') {
        ({ token, email } = await loginWithBrowser({
            server: config.server,
            onCode: async ({ userCode, urlWithCode }) => {
                console.log(`\n! First copy your one-time code: ${userCode}`);
                if (process.stdin.isTTY) {
                    await ask(`Press Enter to open ${urlWithCode} in your browser... `);
                    if (!openBrowser(urlWithCode)) console.log(`Open ${urlWithCode} in your browser to continue.`);
                } else {
                    console.log(`Open ${urlWithCode} in your browser to continue.`);
                }
                console.log('Waiting for you to approve the code in the browser...');
            }
        }));
    } else if (method === 'paste') {
        console.log(`Tip: create a token at ${config.server}/app/?settings=tokens (User Settings > API Tokens).`);
        token = (await promptHidden('Paste your token: ')).trim();
    } else if (method === 'stdin') {
        token = (await readStdin()).trim();
    }

    if (!token) throw new Error('No token given.');

    const user = await verifyToken({ server: config.server, token });
    const path = saveConfig({ server: config.server, token });
    console.log(`✓ Logged in as ${user?.email ?? email ?? 'unknown user'}. Token saved to ${path}`);
}

async function status(config) {
    if (!config.token) {
        console.log(`Not logged in to ${config.server}. Run \`slinghook login\`.`);
        process.exitCode = 1;
        return;
    }
    const user = await verifyToken({ server: config.server, token: config.token });
    const workspace = user?.workspace && !user.workspace.is_personal ? ` in workspace "${user.workspace.name}" (${user.workspace.role})` : '';
    console.log(`✓ Logged in to ${config.server} as ${user?.email ?? 'unknown user'}${workspace}`);
}

async function choose(question, options) {
    console.log(`? ${question}`);
    options.forEach(([, label], i) => console.log(`  ${i + 1}. ${label}`));
    for (;;) {
        const answer = (await ask(`Choose 1-${options.length} [1]: `)).trim() || '1';
        const picked = options[Number(answer) - 1];
        if (picked) return picked[0];
    }
}

async function ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await rl.question(question);
    } finally {
        rl.close();
    }
}

async function readStdin() {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

async function listEndpoints(config) {
    const { endpoints = [] } = await createApi(config).get('/api/endpoints');
    if (endpoints.length === 0) {
        console.log('No endpoints yet. Create one in the dashboard.');
        return;
    }
    for (const ep of endpoints) {
        const status = ep.is_active ? '' : '  (inactive)';
        console.log(`${ep.uuid}  ${ep.name ?? 'Untitled'}${status}`);
    }
}

async function runListen(config, endpointUuid, values) {
    if (!endpointUuid) throw new Error('Missing endpoint UUID. Run `slinghook endpoints` to list yours.');
    if (!values.forward) throw new Error('Missing --forward <url>, e.g. --forward http://localhost:3000/webhooks');

    let target;
    try {
        target = new URL(values.forward).toString();
    } catch {
        throw new Error(`--forward is not a valid URL: ${values.forward}`);
    }

    const retries = values.retries === undefined ? 3 : Number(values.retries);
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) {
        throw new Error('--retries must be a whole number from 0 to 10');
    }

    const claims = (values.claim ?? []).map(parseClaim);
    if (claims.length > 0) {
        await saveClaim(createApi(config), endpointUuid, claims);
        console.log(`Claimed events where ${describeClaim(claims)}`);
    }

    const controller = new AbortController();
    process.once('SIGINT', () => {
        console.log('\nStopping…');
        controller.abort();
    });

    await listen({
        server: config.server,
        token: config.token,
        endpointUuid,
        target,
        mine: values.mine || claims.length > 0,
        report: !values['no-report'],
        retries,
        signal: controller.signal
    });
}

function requireToken(config) {
    if (!config.token) throw new Error('Not logged in. Run `slinghook login` first.');
    return config;
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
