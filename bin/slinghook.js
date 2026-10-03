#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig, saveConfig, stripTrailingSlash } from '../src/config.js';
import { loginWithPassword, verifyToken, promptHidden } from '../src/login.js';
import { listen } from '../src/listen.js';
import { createApi } from '../src/api.js';

const HELP = `slinghook — forward SlingHook webhooks to your local server

Usage:
  slinghook login [--server URL] [--token shk_...]
  slinghook endpoints
  slinghook listen <endpoint-uuid> --forward <url> [--no-report]
  slinghook logout

Options:
  --server URL     SlingHook server (default: saved config or http://127.0.0.1:8080)
  --token TOKEN    Use an existing API token instead of email/password
  --forward URL    Local URL to deliver webhooks to, e.g. http://localhost:3000/webhooks
  --no-report      Don't record deliveries in the dashboard's replay history

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
            forward: { type: 'string', short: 'f' },
            'no-report': { type: 'boolean', default: false },
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
            return login(config, values.token);
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

async function login(config, token) {
    if (!token) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const email = (await rl.question(`Email for ${config.server}: `)).trim();
        rl.close();
        const password = await promptHidden('Password: ');
        token = await loginWithPassword({ server: config.server, email, password });
    }

    const user = await verifyToken({ server: config.server, token });
    const path = saveConfig({ server: config.server, token });
    console.log(`Logged in as ${user?.email ?? 'unknown user'}. Token saved to ${path}`);
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
        report: !values['no-report'],
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
