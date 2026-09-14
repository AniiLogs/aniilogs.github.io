# AniiLogs

AniiLogs is an independent Aniimo community project for an interactive map,
Item-log, Discord-backed accounts, and opt-in public player profiles.

## Architecture

- GitHub Pages serves the public website at `https://aniilogs.github.io`.
- A Cloudflare Pages API at `https://aniilogs-api.pages.dev`, D1 database, and
  private R2 bucket provide the backend without exposing the old account slug.
- Cloudflare D1 stores Discord identities, short-lived website sessions, and
  private-by-default profile settings.
- Reviewed game-derived JSON and image assets live in the private
  `aniilogs-data-prod` R2 bucket. GitHub contains only site/API code;
  package-pinned content is served through `/api/content/releases/3509129/`
  without exposing a bucket listing.
- Discord OAuth requests only the `identify` scope. Access and refresh tokens
  are not retained after the identity lookup.
- GitHub Pages receives a short-lived, one-time OAuth handoff in the URL
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

The primary public deployment is `https://aniilogs.github.io`. GitHub Actions
publishes the reviewed contents of `public` whenever `main` changes. The
account-level Cloudflare `workers.dev` hostname is not part of the public brand.

Discord sign-in uses the dedicated AniiLogs API origin. Configure:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET` (secret)
- `SESSION_SECRET` (secret, at least 32 random bytes)
- `PUBLIC_SITE_ORIGIN=https://aniilogs.github.io`

`apiUrl` in `public/explorer/app-config.js` is pinned to the dedicated API only
after its health, CORS, D1 migrations, and privacy checks pass. The API accepts
browser calls only from the exact configured site origin; wildcard CORS is not
used for account or profile routes. Immutable, read-only R2 release objects use
public read CORS so the local preview can load the same reviewed package.

The Discord application redirect URI must exactly match:

```text
https://aniilogs-api.pages.dev/api/auth/discord/callback
```

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

## Privacy defaults

Profiles are private by default. Public achievements and game identities will
require an explicit user opt-in. The website never receives packet captures or
raw game logs.
