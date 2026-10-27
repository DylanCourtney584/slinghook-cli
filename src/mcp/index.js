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
        tools: createTools({ api: createApi(config), server: config.server, allowRemoteTargets })
    });

    // stdout belongs to the protocol, so this note goes to stderr (clients show it in their MCP logs)
    console.error(`slinghook MCP server ${version} ready (${config.server})`);
    await serveStdio(server);
}
