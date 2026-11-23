# AniiLogs

AniiLogs is an independent Aniimo community project for an interactive map,
Item-log, Discord-backed accounts, and opt-in public player profiles.

## Architecture

- One Cloudflare Pages project, `aniilogs-api`, serves the public website at
  `https://aniilogs.app` (the static files of `public/`) and the API at
  `https://aniilogs-api.pages.dev/api` (the worker, `src/`), with a D1
  database and a private R2 bucket. Both hosts answer both; the site calls the
  API on `aniilogs-api.pages.dev` so Discord's registered redirect stays put.
- `_routes.json` (made by `scripts/site-routes.mjs`) sends only `/api/*`,
  `/lb`, `/lb/*`, `/a/*`, `/m/*`, root placement codes and unknown
  addresses to the worker; the site's files are served directly, with the
  headers in `public/_headers`.
- `https://aniilogs.github.io` (GitHub Pages) is a forwarder: every page sends
  the visitor to the same path, query and fragment on `https://aniilogs.app`
  (`scripts/build-github-forwarder.mjs`).
- Cloudflare D1 stores Discord identities, short-lived website sessions, and
  private-by-default profile settings.
- Reviewed game-derived JSON and image assets live in the private
  `aniilogs-data-prod` R2 bucket. GitHub contains only site/API code;
  package-pinned content is served through `/api/content/releases/3509129/`
  without exposing a bucket listing.
- Discord OAuth requests only the `identify` scope. Access and refresh tokens
  are not retained after the identity lookup.
- The site receives a short-lived, one-time OAuth handoff in the URL
  fragment, exchanges it once, and removes the fragment from browser history.
  API sessions use bearer tokens so the integration does not depend on blocked
  third-party cookies.
- Game-file extraction, packet research, protobuf work, source hashes, and raw
  captures never belong in this public repository.

## Local development

```powershell
npm.cmd install
npm.cmd run db:migrate:local
npm.cmd run dev
```

Copy `.env.example` to `.dev.vars` and add local development credentials only
when testing Discord sign-in. Never commit `.dev.vars`.

## Deployment

The primary public deployment is `https://aniilogs.app`: `api.yml` deploys
the reviewed contents of `public` together with the worker whenever `main`
changes them, and `pages.yml` then publishes the `aniilogs.github.io`
forwarder. The account-level Cloudflare `workers.dev` hostname is not part of
the public brand. `npm run api:dev` (`wrangler pages dev`) serves the site
and the API together locally.

Discord sign-in uses the dedicated AniiLogs API origin. Configure:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET` (secret)
- `SESSION_SECRET` (secret, at least 32 random bytes)
- `PUBLIC_SITE_ORIGIN=https://aniilogs.app`

`apiUrl` in `public/explorer/app-config.js` is pinned to the dedicated API only
after its health, CORS, D1 migrations, and privacy checks pass. The API accepts
browser calls only from the exact configured site origin (and, while it
forwards, the old `https://aniilogs.github.io`); wildcard CORS is not
used for account or profile routes. Immutable, read-only R2 release objects use
public read CORS so the local preview can load the same reviewed package.

The Discord application redirect URI must exactly match:

```text
https://aniilogs-api.pages.dev/api/auth/discord/callback
```

Developer-only model QA uses the existing Discord account roles, not a public
preview password. The API issues a 60-second, one-time handoff to the isolated
Cloudflare renderer-QA Pages project only for an authenticated developer. The
handoff reuses the existing D1 `auth_handoffs` table but has a signed dotted
ticket syntax that the ordinary Discord session exchange explicitly rejects.
QA project redeems it server-to-server using `QA_BRIDGE_SECRET` (a separate
secret configured on both projects), then uses its own signed, HttpOnly,
15-minute first-party cookie for each private asset request. Role changes take
effect at new handoff issuance/redeem; an already issued QA cookie remains
valid for at most 15 minutes. No website session token or game-derived preview
asset is sent through the public API content route.

Apply reviewed production migrations explicitly with:

```powershell
npm.cmd run db:migrate:remote
```

After deployment and before enabling accounts, run the fail-closed live smoke test:

```powershell
npm.cmd run api:smoke -- --api-origin=https://aniilogs-api.pages.dev
```

It verifies API health, OAuth readiness and callback construction, exact-origin
CORS, unauthenticated privacy boundaries, invalid-share rejection, and that the
GitHub Pages configuration points to the same API origin.

The Pages workflow also runs syntax checks, privacy/backend tests, the public
repository boundary, and `release:deploy-check` before uploading anything.
`release-review.json` pins the exact reviewed public file count, byte count, and
tree hash. Its `deploymentApproved` field remains `false` until the owner
explicitly approves publication, so an accidental push cannot deploy this
working tree. Any public-file change must be reviewed and re-pinned before that
approval flag is changed.

## Game-audit tags

Code whose content comes from the game (formulas, rules, tables, generated
catalogs) carries one comment line near the top, never shown to players:

```text
// game-audit: <game version> <YYYY-MM-DD | undated> <what was checked>
// game-audit: unaudited <what in it comes from the game>
// game-audit: n/a <why a file that looks game-related isn't>
```

The version is the installed game's, as `LuaCacheVer.txt` writes it (for
example `1.1.3857679`). Tag only what was actually re-checked against that
version, and move the tag forward after re-checking a part for a new game
version.

```powershell
npm.cmd run game:audit          # report
npm.cmd run game:audit:strict   # exit 1 on anything older, unaudited or untagged
```

The check reads the installed version from `ANIIMO_GAME_DIR` (default: the
Steam install) `Aniimo_Data/cvs/res/lua/LuaCacheVer.txt`, or the newest
`builds/<version>` folder under `ANIIMO_GAME_MAP` (the game-files map), and
skips the version comparison when neither is there. It lists the parts audited
against the installed game, against an older one, unaudited parts, malformed
tags, and game-derived files with no tag. `test/game-audit.test.js` keeps every
game-derived file tagged.

## Privacy defaults

Profiles are private by default. Public achievements and game identities will
require an explicit user opt-in. The website never receives packet captures or
raw game logs.
