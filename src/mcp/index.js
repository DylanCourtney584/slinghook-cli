import { readFileSync } from 'node:fs';
import { createApi } from '../api.js';
import { createMcpServer, serveStdio } from './server.js';
import { createTools, INSTRUCTIONS } from './tools.js';

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

/**
 * `slinghook mcp`: serves the SlingHook tools to an AI agent over stdio, as the
 * logged-in user. The agent's client starts this process itself.
 */
export async function runMcp(config, { allowRemoteTargets = false } = {}) {
    const server = createMcpServer({
        info: { name: 'slinghook', title: 'SlingHook', version },
        instructions: INSTRUCTIONS,
        tools: createTools({ api: config.token ? createApi(config) : signedOutApi(config.server), server: config.server, allowRemoteTargets })
    });

    // stdout belongs to the protocol, so this note goes to stderr (clients show it in their MCP logs)
    console.error(`slinghook MCP server ${version} ready (${config.server}${config.token ? '' : ', not logged in'})`);
    await serveStdio(server);
}

/**
 * Stands in for the API client when there is no token: the tools still list,
 * and every call answers with how to sign in.
 */
export function signedOutApi(server) {
    const refuse = async () => {
        // A plain Error, so explain() passes it through instead of calling it a rejected token
        throw new Error(`Not logged in to ${server}. Run \`npx slinghook login\` once, or set SLINGHOOK_TOKEN in this MCP server's environment, then restart it.`);
    };

    return { get: refuse, post: refuse, put: refuse, postRaw: refuse };
}
