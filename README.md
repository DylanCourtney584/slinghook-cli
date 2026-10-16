# slinghook CLI

Forwards webhooks captured by a SlingHook server to a server on your machine,
such as `localhost:3000`. A hosted SlingHook instance can't reach your localhost,
so the CLI makes the connection outbound, the same way `stripe listen` does.

Requires Node 18.17+. There are no dependencies.

```bash
npm install -g slinghook

slinghook login --server https://slinghook.co.za
slinghook endpoints            # list your endpoint UUIDs
slinghook listen <uuid> --forward http://localhost:3000/webhooks
```

```
● Listening on endpoint 3f1c…
  Forwarding to http://localhost:3000/webhooks

14:02:11 POST   #1234 → 200 37ms sig:valid
14:02:15 POST   #1235 → ✗ Connection refused (is your local server running?) 2ms
```

## How it works

1. **Auth.** `slinghook login` signs in with your email and password,
   creates a personal API token (`POST /api/tokens`), and signs that session out.
   If the account has two-factor sign-in, it asks for the code (or a recovery code).
   Accounts that sign in with Google, GitHub or SAML have no password: create a
   token in the dashboard and use `slinghook login --token shk_…`.
   Only the token is saved, in `~/.config/slinghook/config.json` (mode 0600).
   The server stores only a SHA-256 hash of the token. Use `--token shk_…` or
   `SLINGHOOK_TOKEN` to skip the prompt, for example in CI. You can create,
   view, and revoke tokens under **User Settings → API Tokens** in the dashboard.
2. **Stream.** `listen` opens `GET /v1/events/<uuid>` with
   `Authorization: Bearer <token>`. This is the same SSE stream the dashboard uses.
   On first connect the server sends recent `history`, which the CLI skips. It
   forwards only new `log` events.
3. **Reconnect.** The server closes the stream every ~55s by design. The CLI
   reconnects with `Last-Event-ID`, so webhooks that arrive during the gap are
   delivered once and in order. Network errors back off from 1s up to 30s.
4. **Forward.** Each webhook is re-sent with its original method, body, query
   string, and headers. Hop-by-hop headers such as `Host` and `Content-Length`
   are dropped. Signature headers are kept, so your app's verification runs
   for real. The CLI adds `X-Webhook-Replay: true` and `X-SlingHook-Log-Id`.
   Deliveries run one at a time with a 15s timeout. Payloads that were
   truncated at capture are skipped.
   If your server is down, times out, or answers 408, 425, 429 or 5xx, the CLI
   retries 3 more times (after 1s, 2s and 4s) before moving on. Later webhooks
   wait, so they still arrive in order. `--retries N` changes the count (0 to 10).
5. **Report.** Each result is posted to `POST /api/logs/<id>/replays`, so it
   appears in the dashboard's replay history. Use `--no-report` to turn this off.

## Team routing: one provider URL, many developers

On the Team plan, a whole team can share one endpoint (Stripe and Shopify only
allow a few webhook URLs) and still each get their own events on their own
machine. Claim the events that are yours, then listen with `--mine`:

```bash
# Events whose body has metadata.dev = "alice" go to Alice's localhost
slinghook listen <uuid> --forward http://localhost:3000/webhooks \
  --claim data.object.metadata.dev=alice

# Or claim by a header or query parameter
slinghook listen <uuid> --forward http://localhost:3000/webhooks --claim header:X-Dev=alice
```

`--claim` saves your claim on the endpoint (replacing your earlier one) and
implies `--mine`. Repeat it to require several conditions. You can also edit
claims under **Endpoint Settings → Team routing** in the dashboard, then run
`listen --mine` without `--claim`.

With `--mine`, the CLI forwards only the events routed to you, and the open
stream counts you as online. Events nobody claims stay in the shared feed for
everyone to see, unless the endpoint is set to give them to whoever is online,
in which case they go round-robin to the people running `listen --mine`.
Viewers can watch but can't claim events.

Don't run the CLI and the dashboard's Auto-Relay toggle for the same endpoint at
the same time, or each webhook will be delivered twice.

## Known gaps

- Bodies travel through the JSON event stream as text, so binary payloads aren't
  forwarded byte-for-byte.
- There are no retries yet. A failed delivery is reported, and you can replay it
  from the dashboard.

## Developing

From a checkout of the SlingHook repo, `cd cli && npm link` puts your working copy on
your PATH, and `npm test` runs the tests.

## Publishing

Bump `version` in `package.json`, then run `npm publish` from this folder. The tests run
first (`prepublishOnly`), and only `bin/`, `src/`, this README and `package.json` are
included in the package.
