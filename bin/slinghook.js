#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { select } from '@inquirer/prompts';
import { loadConfig, saveConfig, stripTrailingSlash } from '../src/config.js';
import { loginWithBrowser, openBrowser, verifyToken, promptHidden } from '../src/login.js';
import { listen } from '../src/listen.js';
import { runChaos } from '../src/chaos.js';
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
  slinghook ${cyan('chaos')}     <endpoint-uuid|catch-url> --forward <url> (--scenario ID | --request ID)
                        [--check URL] [--only TESTS] [--late-delay SECONDS]
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

${bold('Chaos mode')} ${dim('(Pro and Team): re-sends captured webhooks to your handler as duplicates,')}
${dim('concurrent duplicates, out of order, late retries and with broken bodies, then reports how it coped.')}
  --scenario ID    Saved scenario to use (run without it to list them)
  --request ID     A single captured request to use instead
  --check URL      GET on your app that shows its state (e.g. an order count); read after
                   each test to prove redeliveries changed nothing
  --only TESTS     Comma-separated: duplicates,concurrent,out_of_order,malformed,late_retry
  --late-delay S   Seconds to wait before the late retry (default: 5)
  Exits with code 1 when a test fails, so it can run in CI.

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
            scenario: { type: 'string' },
            request: { type: 'string' },
            check: { type: 'string' },
            only: { type: 'string' },
            'late-delay': { type: 'string' },
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
        case 'chaos':
            return runChaosCommand(requireToken(config), rest[0], values);
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

const CHAOS_ICON = { pass: green('✓'), warn: yellow('!'), fail: red('✗'), skipped: dim('–') };

async function runChaosCommand(config, endpoint, values) {
    if (!endpoint) throw new Error('Missing endpoint UUID. Run `slinghook endpoints` to list yours.');
    if (!values.forward) throw new Error('Missing --forward <url>, e.g. --forward http://localhost:3000/webhooks');

    const target = parseUrlOption(values.forward, '--forward');
    const checkUrl = values.check ? parseUrlOption(values.check, '--check') : null;
    const api = createApi(config);
    const endpointUuid = await resolveEndpointUuid(api, endpoint);

    if (!values.scenario && !values.request) {
        const { scenarios = [] } = await api.get(`/api/scenarios?endpoint=${encodeURIComponent(endpointUuid)}`);
        if (scenarios.length === 0) {
            throw new Error('This endpoint has no scenarios. Save one in the dashboard, or pass --request <id> to use one captured request.');
        }
        console.log(`\nScenarios on this endpoint:\n`);
        for (const s of scenarios) console.log(`  ${cyan(String(s.id).padStart(5))}  ${s.name} ${dim(`(${s.step_count} requests)`)}`);
        console.log(`\n${dim('Run one with')} slinghook chaos ${endpoint} --forward ${target} --scenario <id>\n`);
        process.exitCode = 1;
        return;
    }

    let lateDelayMs;
    if (values['late-delay'] !== undefined) {
        const seconds = Number(values['late-delay']);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60) throw new Error('--late-delay must be 0 to 60 seconds');
        lateDelayMs = Math.round(seconds * 1000);
    }

    const controller = new AbortController();
    process.once('SIGINT', () => {
        console.log(`\n${dim('Stopping…')}`);
        controller.abort();
    });

    let currentTest = null;
    const run = await runChaos({
        api,
        signal: controller.signal,
        run: {
            endpoint: endpointUuid,
            scenario_id: values.scenario ? Number(values.scenario) : undefined,
            log_id: values.request ? Number(values.request) : undefined,
            target_url: target,
            check_url: checkUrl ?? undefined,
            tests: values.only ? values.only.split(',').map((t) => t.trim()).filter(Boolean) : undefined,
            late_delay_ms: lateDelayMs
        },
        logger: {
            started(run) {
                console.log(`\n${cyan('●')} Chaos testing ${bold(run.name)} against ${target}`);
                if (!checkUrl) console.log(dim('  Tip: add --check <url> so the report can prove redeliveries changed nothing'));
                console.log();
            },
            waiting(round, ms) {
                console.log(dim(`  waiting ${ms / 1000}s before the late retry…`));
            },
            round(i, round, answers) {
                if (round.test !== currentTest) {
                    currentTest = round.test;
                    console.log(`  ${bold(round.test.replace(/_/g, ' '))}`);
                }
                const codes = answers.map((a) => (a.error ? red(a.error) : (a.status < 300 ? green : a.status < 500 ? yellow : red)(String(a.status))));
                const variant = round.shots[0].variant ? dim(` ${round.shots[0].variant}`) : '';
                console.log(`    ${dim(`#${round.shots[0].log_id}`)}${variant}  ${codes.join(dim(' · '))}`);
            }
        }
    });

    const report = run.report;
    console.log(`\n${bold('Report')}\n`);
    for (const test of report.tests) {
        const icon = CHAOS_ICON[test.verdict] ?? dim('○');
        const state = test.state === 'unchanged' ? dim(' · state unchanged') : test.state === 'changed' ? red(' · state changed') : '';
        console.log(`  ${icon} ${test.title}${state}${test.reason ? dim(` (${test.reason})`) : ''}`);
        for (const finding of test.findings ?? []) console.log(`      ${dim(finding)}`);
    }
    if (report.stopped_reason) console.log(`\n${yellow('!')} ${report.stopped_reason}`);

    const color = { passed: green, warned: yellow, failed: red, stopped: yellow }[run.status] ?? dim;
    console.log(`\n${color(run.status.toUpperCase())} ${dim(`· ${report.passed} passed, ${report.warned} warnings, ${report.failed} failed · saved to the dashboard`)}\n`);
    if (run.status === 'failed') process.exitCode = 1;
}

function parseUrlOption(value, flag) {
    try {
        return new URL(value).toString();
    } catch {
        throw new Error(`${flag} is not a valid URL: ${value}`);
    }
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