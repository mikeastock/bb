# Self-hosting bb connect

How to run your own bb connect gate on your own domain, instead of pairing to
getbb.app. The reference deployment is btool.sh, whose committed configs are
[`apps/connect/wrangler.btool.jsonc`](../apps/connect/wrangler.btool.jsonc) and
[`apps/web/wrangler.btool.jsonc`](../apps/web/wrangler.btool.jsonc) — read those
alongside this document; they carry the concrete IDs.

## What you are deploying

Two Cloudflare Workers sharing one D1 database:

| Worker | Source | Role |
| --- | --- | --- |
| `bb-connect` | `apps/connect` | Tunnel gate + `TunnelDO`. Authenticates visitors and relays their requests down a WebSocket to a paired bb. |
| `bb-web` | `apps/web` | Account app: better-auth sign-in, dashboard, pairing codes. |

They must share one `BETTER_AUTH_SECRET` — `bb-web` signs the session cookie and
the gate verifies its HMAC — and `bb-web` binds `TUNNEL_DO` cross-script into
`bb-connect` so revoking a machine can sever a live tunnel.

## Topology

The reference deployment puts the app on a subdomain rather than the apex, so
the gate keeps the entire wildcard for labels:

```
bb.<domain>                    → bb-web        (account app)
<handle>.<domain>              → bb-connect    → a paired bb
<handle>--<port>.<domain>      → bb-connect    → a shared port
<domain>/api/connect/*         → bb-web        (mobile enrollment)
<domain>/.well-known/*         → bb-web        (mobile app links)
other <domain> requests        → 301 → bb.<domain>
```

`bb` is in `RESERVED_HANDLES`, so it can never be claimed as a server label.
`BASE_DOMAIN` stays the registrable apex even though the app is on `bb.`: server
URLs derive from `BASE_DOMAIN`, and better-auth scopes its cookie to
`.<domain>`, which is what lets the gate validate the same session on
`<handle>.<domain>`.

Mobile pairing derives the account apex from the paired server URL. The apex
API and app-link paths therefore route directly to `bb-web`; redirecting those
requests to `bb.<domain>` breaks POST requests and mobile app association.

### Bind the app with a route, not a custom domain

A custom domain on `bb.<domain>` **loses** to the gate's `*.<domain>/*` route.
Every request reaches the gate, which sees the reserved label `bb` and 301s to
`ACCOUNT_APP_URL` — itself — so the app becomes an infinite redirect loop. Use
an explicit route `bb.<domain>/*`, which wins on route-vs-route specificity.

## One-time account setup

Not covered by the committed configs — these are manual:

1. **Claim a workers.dev subdomain.** Cloudflare refuses *every* Worker deploy
   until the account has one, even with `workers_dev: false`. Open Workers &
   Pages in the dashboard once, or `PUT /accounts/{account_id}/workers/subdomain`.

2. **Create the D1 database** and apply the schema:

   ```sh
   cd apps/connect
   pnpm exec wrangler d1 migrations apply DB --remote -c wrangler.btool.jsonc
   ```

   Applies `packages/connect-db/migrations` (through `0005`, which installs the
   `label_claim` triggers). Do this before deploying either worker.

3. **DNS.** One proxied wildcard record is what makes the gate's zone route
   resolve. Content is a TEST-NET-1 placeholder — no traffic reaches it, the
   Worker answers:

   | Type | Name | Content | Proxied |
   | --- | --- | --- | --- |
   | A | `*` | `192.0.2.1` | yes |
   | A | `@` | `192.0.2.1` | yes (only with the apex redirect below) |

   A DNS wildcard covers exactly one label, so `*.<domain>` matches
   `handle.<domain>` but **not** the apex, and not `x.bb.<domain>`. Universal SSL
   covers the same one level.

4. **Apex redirect** (optional). A Single Redirect on the
   `http_request_dynamic_redirect` phase sends ordinary apex requests to
   `concat("https://bb.<domain>", http.request.uri.path)` with status 301 and
   the query string preserved. Exclude the paths routed directly to `bb-web`:

   ```text
   (http.host eq "<domain>"
    and not starts_with(http.request.uri.path, "/api/connect/")
    and not starts_with(http.request.uri.path, "/.well-known/"))
   ```

   Without the redirect, the dashboard link derived from the paired server URL
   is dead. Without the exclusions, mobile pairing receives redirect HTML
   instead of the account API's JSON response.

   Create the rule **before** adding the apex DNS record — a record with no rule
   serves 522s against the placeholder IP instead of a clean NXDOMAIN.

   The API permission is **Dynamic URL Redirects Write**. *Not* Zone Transform
   Rules Write, which governs rewrites and header transforms.

5. **GitHub OAuth app** — an OAuth App (not a GitHub App):

   - Homepage URL: `https://bb.<domain>`
   - Authorization callback URL: `https://bb.<domain>/api/auth/callback/github`

   Scopes aren't configured on the app; better-auth requests `read:user` and
   `user:email` at authorization time.

6. **Secrets** — see below.

## Deploying

The gate is a plain worker deploy:

```sh
cd apps/connect
pnpm exec wrangler deploy -c wrangler.btool.jsonc
```

The account app resolves its config at **build** time. `@cloudflare/vite-plugin`
bakes vars and bindings into `dist/server/wrangler.json`, and `wrangler deploy`
follows the `.wrangler/deploy/config.json` redirect to it — so `deploy -c`
cannot select a deployment. Choose it with `BB_WEB_WRANGLER_CONFIG`:

```sh
BB_WEB_WRANGLER_CONFIG=./wrangler.btool.jsonc pnpm exec turbo run build --filter=@bb/web
cd apps/web && pnpm exec wrangler deploy
```

That variable is declared in `turbo.json` under `@bb/web#build`. Turbo strips
undeclared env vars, so an undeclared override silently does nothing and you
ship the *upstream* config. Declaring it also puts it in the cache key, so
switching targets cannot reuse another deployment's build output. After
building, confirm the target before deploying:

```sh
python3 -c 'import json;print(json.load(open("dist/server/wrangler.json"))["vars"])'
```

## Secrets

Set with `wrangler secret put <NAME> -c wrangler.btool.jsonc` from the relevant
app directory. **The `-c` flag is required** — without it wrangler reads the
upstream `wrangler.jsonc` and will happily create a worker under that config's
name instead.

| Secret | Worker | Notes |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | both | Must be byte-identical on both. A mismatch breaks visitor auth silently. |
| `GITHUB_CLIENT_ID` | `bb-web` | Not really secret (it appears in the authorize URL), but declared required. |
| `GITHUB_CLIENT_SECRET` | `bb-web` | Regenerable in the OAuth app. |

`wrangler deploy` refuses to create the script until every secret listed under
`secrets.required` exists, so set them first — `secret put` will create a draft
worker for you.

Cloudflare secrets and API tokens are **write-only**: `secret list` returns
names only, and the token API never returns a value after creation. Cloudflare
is therefore not a backup — keep copies in a password manager, along with the
deploy API token, which is likewise unreadable after it is minted.

Every one of these is regenerable, so losing them costs a rotation, not the
deployment. Rotating `BETTER_AUTH_SECRET` signs everyone out.

## Access control

Upstream is open-signup: any GitHub account can sign in and claim labels. For a
private deployment set `ALLOWED_GITHUB_LOGINS` in the worker's `vars` to a
comma-separated list of GitHub logins. Leaving it unset preserves open signup;
setting it to a value that lists nobody throws rather than silently falling open.

Adding or removing a login takes effect on the next deploy of `bb-web`.

It is enforced in `mapProfileToUser` (`apps/web/src/server/auth.ts`), which runs
on every sign-in against the profile GitHub returns for the exchanged token.
That value is authoritative and not caller-supplied.

It deliberately does **not** check the stored `user.github_login` column, which
is null for every OAuth user: better-auth's
`parseAdditionalUserInputFromProviderProfile` drops fields declared
`input: false` from the provider profile, so the `mapProfileToUser` mapping never
reaches the database. Gating on that column refuses everyone. (This also affects
getbb.app, where the dashboard's GitHub link is silently absent.) Changing the
field to `input: true` would fix persistence but make it caller-settable, which
is unacceptable for a field authorization depends on.

## Pairing a bb

When the app host differs from `BASE_DOMAIN`, pairing needs **both** flags:

```sh
bb connect --code <CODE> --base-url https://bb.<domain> --server https://<handle>.<domain>
```

- `--base-url` points code redemption at the account app. Without it the client
  uses its hardcoded `https://getbb.app`.
- `--server` sets the tunnel destination. Without it, `serverUrlForHandle`
  appends the handle to the base URL's host and derives
  `<handle>.bb.<domain>` — two labels deep, covered by neither the DNS wildcard
  nor the certificate.

Share URLs derive correctly from the server URL, so
`https://<handle>--<port>.<domain>` works with no further configuration.

### Pairing the mobile app

Settings → Remote access → **Add mobile device** and
`bb connect machine-code` derive `https://<domain>` from the paired server URL.
The committed `bb-web` routes and the apex redirect exclusions above must both
be active. The generated pairing payload then names the account apex and the
paired server separately, so the mobile app redeems its code at the apex and
connects to `https://<handle>.<domain>`.

## Verifying

The gate proxies `/install.sh` and `/install/version` without authentication, so
you can prove the whole relay path with no session:

```sh
curl https://<handle>.<domain>/install/version   # served by your local bb, through the tunnel
```

Other useful signals: an unauthenticated visitor to `<handle>.<domain>` should
get a 401 sign-in page; an unknown label 404s; `bb connect status --json`
reports `state: connected` and `remoteClients` counts live realtime sockets.

Mobile pairing has three focused checks:

```sh
curl -X POST https://<domain>/api/connect/machine-code
curl https://<domain>/.well-known/apple-app-site-association
bb connect machine-code --json
```

The unauthenticated POST returns a JSON 401 rather than redirect HTML, the app
association returns JSON 200, and the authenticated CLI command returns the
apex, paired server URL, one-time code, and expiry.

Note that auth runs **before** routing, so a request to an unshared port returns
401 (not shared → not signed in) rather than 404. The tunnel client is what
answers `this port is not shared`, and only for an authenticated request.

## Known gaps

- **Machine-label tunnels are unexercised** on this deployment. Shares from an
  enrolled host other than the server host (`<machine-label>--<port>`, served by
  the daemon's own `ConnectTunnelClient`) have never been run against it.
- **No deploy automation.** `.github/workflows/deploy-web.yml` targets the
  upstream account; both workers here are deployed by hand.
