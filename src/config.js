import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const DEFAULT_SERVER = 'http://127.0.0.1:8080';

export function configPath() {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(base, 'slinghook', 'config.json');
}

/**
 * Saved config, overridden by SLINGHOOK_SERVER / SLINGHOOK_TOKEN when set.
 */
export function loadConfig() {
    let saved = {};
    try {
        saved = JSON.parse(readFileSync(configPath(), 'utf8'));
    } catch {
        // No config yet
    }

    return {
        server: stripTrailingSlash(process.env.SLINGHOOK_SERVER || saved.server || DEFAULT_SERVER),
        token: process.env.SLINGHOOK_TOKEN || saved.token || null
    };
}

export function saveConfig(config) {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    // writeFileSync only applies mode on create; tighten an existing file too
    chmodSync(path, 0o600);
    return path;
}

export function stripTrailingSlash(url) {
    return url.replace(/\/+$/, '');
}
