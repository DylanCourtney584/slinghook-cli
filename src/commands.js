const AUTH_COMMANDS = ['login', 'logout', 'status'];

/**
 * The command to run and its arguments. `auth login|logout|status` (as in
 * `gh auth login`) is the same command as the bare `login|logout|status`,
 * which keep working.
 *
 * @param {string[]} positionals
 * @returns {{command: ?string, args: string[]}}
 */
export function resolveCommand(positionals) {
    const [first, ...rest] = positionals;
    if (first !== 'auth') return { command: first ?? null, args: rest };

    const [sub, ...args] = rest;
    if (!AUTH_COMMANDS.includes(sub)) {
        throw new Error(`Usage: shk auth ${AUTH_COMMANDS.join('|')}`);
    }
    return { command: sub, args };
}
