// Fix verification, as the dashboard's replayCompare.js works it out: a replay
// is compared with the attempt before it to the same target URL. Attempts are
// the rows from GET /api/logs/:id/replays, newest first.

/** A 2xx with no transport error counts as the handler accepting the webhook */
export function isPassing(attempt) {
    const status = attempt?.response_status;
    return !attempt?.error_message && status !== null && status !== undefined && status >= 200 && status < 300;
}

/** The latest older attempt to the same URL, or else the latest older attempt to any URL */
export function findBaseline(attempts, current) {
    const index = attempts.findIndex((a) => a.id === current?.id);
    if (index === -1) return null;
    const older = attempts.slice(index + 1);
    return older.find((a) => a.target_url === current.target_url) ?? older[0] ?? null;
}

/** fixed | regressed | still_failing | still_passing, or null without a baseline */
export function verdictFor(baseline, current) {
    if (!baseline || !current) return null;
    const before = isPassing(baseline);
    const after = isPassing(current);
    if (!before && after) return 'fixed';
    if (before && !after) return 'regressed';
    return after ? 'still_passing' : 'still_failing';
}
