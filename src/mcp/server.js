import { createInterface } from 'node:readline';

/**
 * A minimal Model Context Protocol server over stdio.
 *
 * MCP is JSON-RPC 2.0: the client (Claude Code, Cursor, ...) starts this
 * process and writes one JSON message per line to its stdin; we answer one per
 * line on stdout. So stdout carries protocol only: anything else printed there
 * (a stray console.log) breaks the session. Diagnostics go to stderr.
 *
 * Only the tools capability is offered, which needs four methods: initialize,
 * tools/list, tools/call and ping.
 */

// Newest first; we answer with the client's version when we know it
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/**
 * @param {object} opts
 * @param {{name: string, version: string}} opts.info
 * @param {string} [opts.instructions]  Shown to the model: when and how to use these tools
 * @param {Array<{name: string, description: string, inputSchema: object, annotations?: object, handler: Function}>} opts.tools
 */
export function createMcpServer({ info, instructions, tools }) {
    const byName = new Map(tools.map((t) => [t.name, t]));

    /**
     * Handles one parsed message. Returns the response object, or null for a
     * notification (a message without an id needs no answer).
     */
    async function handle(message) {
        if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
            return error(message?.id ?? null, INVALID_REQUEST, 'Invalid request');
        }

        const { id, method, params = {} } = message;
        const isNotification = id === undefined;

        let result;
        switch (method) {
            case 'initialize': {
                const asked = params.protocolVersion;
                result = {
                    protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: info,
                    ...(instructions ? { instructions } : {})
                };
                break;
            }
            case 'ping':
                result = {};
                break;
            case 'tools/list':
                result = {
                    tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
                        name,
                        ...(title ? { title } : {}),
                        description,
                        inputSchema,
                        ...(annotations ? { annotations } : {})
                    }))
                };
                break;
            case 'tools/call': {
                const tool = byName.get(params.name);
                if (!tool) return error(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
                result = await callTool(tool, params.arguments ?? {});
                break;
            }
            default:
                // notifications/initialized, notifications/cancelled, ...: nothing to do
                if (isNotification) return null;
                return error(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
        }

        return isNotification ? null : { jsonrpc: '2.0', id, result };
    }

    return { handle };
}

/**
 * Runs a tool. A failure is still a successful JSON-RPC answer, with
 * isError: true, so the model reads the message and can correct itself (a
 * protocol error would only tell it the call broke).
 */
async function callTool(tool, args) {
    try {
        const output = await tool.handler(args);
        const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
        return { content: [{ type: 'text', text }] };
    } catch (err) {
        return { content: [{ type: 'text', text: err.message || String(err) }], isError: true };
    }
}

function error(id, code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Serves `server` on stdin/stdout until stdin closes.
 */
export async function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
    const write = (msg) => output.write(JSON.stringify(msg) + '\n');
    const pending = new Set();
    const lines = createInterface({ input, crlfDelay: Infinity });

    for await (const line of lines) {
        if (!line.trim()) continue;

        let message;
        try {
            message = JSON.parse(line);
        } catch {
            write(error(null, PARSE_ERROR, 'Parse error'));
            continue;
        }

        // Calls run concurrently (a slow replay shouldn't hold up a ping)
        const job = server.handle(message)
            .then((response) => response && write(response))
            .catch((err) => write(error(message.id ?? null, -32603, err.message)));
        pending.add(job);
        job.finally(() => pending.delete(job));
    }

    await Promise.all(pending);
}
