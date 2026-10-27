// Fix verification, as the dashboard's replayCompare.js works it out: a replay
// is compared with the attempt before it to the same target URL. Attempts are
// the rows from GET /api/logs/:id/replays, newest first.

/**
 * SlingHook found the event's signature invalid, so a handler that checks
 * signatures should refuse it. Unverified events keep "2xx = pass".
 */
export function expectsRejection(log) {
    return log?.signature_status === 'invalid';
}

/** A 2xx (or a 4xx when a rejection is expected) with no transport error; a 5xx never passes */
export function isPassing(attempt, expectRejection = false) {
    const status = attempt?.response_status;
    if (attempt?.error_message || status === null || status === undefined) return false;
    return expectRejection ? status >= 400 && status < 500 : status >= 200 && status < 300;
}

/** The latest older attempt to the same URL, or else the latest older attempt to any URL */
export function findBaseline(attempts, current) {
    const index = attempts.findIndex((a) => a.id === current?.id);
    if (index === -1) return null;
    const older = attempts.slice(index + 1);
    return older.find((a) => a.target_url === current.target_url) ?? older[0] ?? null;
}

/** fixed | regressed | still_failing | still_passing, or null without a baseline */
export function verdictFor(baseline, current, expectRejection = false) {
    if (!baseline || !current) return null;
    const before = isPassing(baseline, expectRejection);
    const after = isPassing(current, expectRejection);
    if (!before && after) return 'fixed';
    if (before && !after) return 'regressed';
    return after ? 'still_passing' : 'still_failing';
}
