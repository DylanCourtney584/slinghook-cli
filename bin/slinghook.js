#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { select } from '@inquirer/prompts';
import { loadConfig, saveConfig, stripTrailingSlash } from '../src/config.js';
import { loginWithBrowser, openBrowser, verifyToken, promptHidden } from '../src/login.js';
import { listen } from '../src/listen.js';
import { createApi } from '../src/api.js';
import { parseClaim, saveClaim, describeClaim } from '../src/claims.js';
import { resolveEndpointUuid } from '../src/endpoint.js';

// ANSI styling helpers (automatically disabled in non-TTY or with NO_COLOR)
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

const HELP = `
${bold('slinghook')} — forward SlingHook webhooks to your local server

${bold('Usage:')}
  slinghook ${cyan('login')}     [--server URL] [--web | --with-token | --token shk_...]
  slinghook ${cyan('status')}
  slinghook ${cyan('endpoints')}
  slinghook ${cyan('listen')}    <endpoint-uuid|catch-url> --forward <url> [--retries N] [--no-report]
                        [--mine] [--claim FIELD=VALUE ...]
  slinghook ${cyan('logout')}

${bold('Options:')}
  --server URL     SlingHook server (default: saved config or http://127.0.0.1:8080)
  --web            Log in with your browser (skips the choice prompt)
  --with-token     Read a personal access token from standard input
  --token TOKEN    Log in with this personal access token directly
  --forward URL    Local URL to deliver webhooks to, e.g. http://localhost:3000/webhooks
  --retries N      Extra tries when local server is down or answers 5xx (default: 3)
  --no-report      Don't record deliveries in the dashboard's replay history
  --mine           Team routing: forward only events routed to you
  --claim SPEC     Save a claim on this endpoint first (implies --mine)
                   e.g. data.object.metadata.dev=alice or header:X-Dev=alice

${bold('Environment:')}
  ${dim('SLINGHOOK_SERVER, SLINGHOOK_TOKEN override the saved configuration.')}
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
            console.log(`\n${green('✓')} Logged out from ${cyan(config.server)}`);
            console.log(`  ${dim('Removed saved token. Revoke it on the dashboard if it may have leaked.\n')}`);
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
        console.log(`\nLogging in to ${cyan(config.server)}\n`);
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
                console.log(`\n${yellow('!')} First copy your one-time code:\n`);
                console.log(`    ${bold(cyan(userCode))}\n`);

                if (process.stdin.isTTY) {
                    await ask(`Press ${bold('Enter')} to open your browser... `);
                    const opened = openBrowser(urlWithCode);
                    if (!opened) {
                        console.log(`\n${dim('Open this link in your browser:')}\n  ${cyan(urlWithCode)}`);
                    }
                } else {
                    console.log(`\n${dim('Open this link in your browser:')}\n  ${cyan(urlWithCode)}`);
                }
                console.log(`\n${dim('Waiting for you to approve the code in the browser...')}`);
            }
        }));
    } else if (method === 'paste') {
        console.log(`\n${dim(`Tip: create a token at ${cyan(`${config.server}/app/?settings=tokens`)} (User Settings > API Tokens)`)}`);
        token = (await promptHidden('Paste your token: ')).trim();
    } else if (method === 'stdin') {
        token = (await readStdin()).trim();
    }

    if (!token) throw new Error('No token given.');

    const user = await verifyToken({ server: config.server, token });
    const path = saveConfig({ server: config.server, token });

    const userEmail = user?.email ?? email ?? 'unknown user';
    console.log(`\n${green('✓')} Logged in as ${bold(userEmail)}`);
    console.log(`  ${dim(`Token saved to ${path}\n`)}`);
}

async function status(config) {
    if (!config.token) {
        console.log(`\n${yellow('!')} Not logged in to ${cyan(config.server)}`);
        console.log(`  Run ${bold('slinghook login')} to get started.\n`);
        process.exitCode = 1;
        return;
    }

    const user = await verifyToken({ server: config.server, token: config.token });
    const userEmail = user?.email ?? 'unknown user';

    console.log(`\n${green('✓')} Authenticated with ${cyan(config.server)}`);
    console.log(`  ${dim('Account:')}   ${bold(userEmail)}`);

    if (user?.workspace && !user.workspace.is_personal) {
        console.log(`  ${dim('Workspace:')} ${user.workspace.name} ${dim(`(${user.workspace.role})`)}`);
    }
    console.log();
}

async function listEndpoints(config) {
    const { endpoints = [] } = await createApi(config).get('/api/endpoints');
    if (endpoints.length === 0) {
        console.log(`\n${yellow('!')} No endpoints yet.`);
        console.log(`  Create one in your dashboard at ${cyan(`${config.server}/app`)}\n`);
        return;
    }

    console.log(`\nEndpoints on ${cyan(config.server)}:\n`);
    for (const ep of endpoints) {
        const dot = ep.is_active ? green('●') : dim('○');
        const name = ep.name ? bold(ep.name) : dim('Untitled');
        const status = ep.is_active ? '' : dim(' (inactive)');
        console.log(`  ${dot}  ${dim(ep.uuid)}   ${name}${status}`);
    }

    console.log(`\n${dim('To forward events locally:')}`);
    console.log(`  slinghook listen <uuid> --forward http://localhost:3000/webhooks\n`);
}

async function runListen(config, endpoint, values) {
    if (!endpoint) throw new Error('Missing endpoint UUID. Run `slinghook endpoints` to list yours.');
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
    const endpointUuid = await resolveEndpointUuid(createApi(config), endpoint);
    if (claims.length > 0) {
        await saveClaim(createApi(config), endpointUuid, claims);
        console.log(`\n${green('✓')} Claimed events where ${cyan(describeClaim(claims))}\n`);
    }

    const controller = new AbortController();
    process.once('SIGINT', () => {
        console.log(`\n${dim('Stopping…')}`);
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

async function choose(question, options) {
    try {
        return await select({
            message: question,
            choices: options.map(([value, name]) => ({
                name,
                value
            }))
        });
    } catch (err) {
        if (err.name === 'ExitPromptError') {
            process.exit(130);
        }
        throw err;
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

function requireToken(config) {
    if (!config.token) throw new Error(`Not logged in to ${config.server}. Run \`slinghook login\` first.`);
    return config;
}

main(process.argv.slice(2)).catch((err) => {
    console.error(`\n${red('✗ Error:')} ${err.message}\n`);
    process.exit(1);
});