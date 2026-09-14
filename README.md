# AniiLogs

AniiLogs is an independent Aniimo community project for an interactive map,
Item-log, Discord-backed accounts, and opt-in public player profiles.

## Architecture

- Cloudflare Workers Static Assets serves the website and API from one origin.
- Cloudflare D1 stores Discord identities, short-lived website sessions, and
  private-by-default profile settings.
- Discord OAuth requests only the `identify` scope. Access and refresh tokens
  are not retained after the identity lookup.
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

Cloudflare builds the `main` branch and runs `npx wrangler deploy`. Before
enabling Discord sign-in, configure these deployment values:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET` (secret)
- `SESSION_SECRET` (secret, at least 32 random bytes)

The Discord application redirect URI must match:

```text
https://<production-origin>/api/auth/discord/callback
```

Apply reviewed production migrations explicitly with:

```powershell
npm.cmd run db:migrate:remote
```

## Privacy defaults

Profiles are private by default. Public achievements and game identities will
require an explicit user opt-in. The website never receives packet captures or
raw game logs.
