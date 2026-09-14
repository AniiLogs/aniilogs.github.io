import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function origin(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL origin.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${label} must contain only scheme and host.`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
    throw new Error(`${label} must use HTTPS outside localhost.`);
  }
  return parsed.origin;
}

async function jsonResponse(url, init, expectedStatus) {
  const response = await fetch(url, { redirect: "manual", ...init });
  if (response.status !== expectedStatus) {
    throw new Error(`${init?.method || "GET"} ${url} returned ${response.status}, expected ${expectedStatus}.`);
  }
  return { response, payload: await response.json() };
}

const apiOrigin = origin(option("api-origin"), "--api-origin");
const publicOrigin = origin(option("public-origin", "https://aniilogs.github.io"), "--public-origin");
const expectOauth = option("expect-oauth", "true") === "true";
const skipPublicConfig = flag("skip-public-config");
const reportPath = option("report");
const api = `${apiOrigin}/api`;
const checks = [];

const allowedHealth = await jsonResponse(`${api}/health`, {
  headers: { origin: publicOrigin },
}, 200);
if (allowedHealth.payload.ok !== true || allowedHealth.payload.discordLoginConfigured !== expectOauth) {
  throw new Error(`Health OAuth readiness mismatch: ${JSON.stringify(allowedHealth.payload)}`);
}
if (allowedHealth.response.headers.get("access-control-allow-origin") !== publicOrigin) {
  throw new Error("Health response did not return exact-origin CORS.");
}
checks.push("health_and_oauth_readiness", "exact_origin_get_cors");

const allowedPreflight = await fetch(`${api}/progress`, {
  method: "OPTIONS",
  headers: { origin: publicOrigin, "access-control-request-method": "PUT", "access-control-request-headers": "authorization, content-type" },
});
if (allowedPreflight.status !== 204 || allowedPreflight.headers.get("access-control-allow-origin") !== publicOrigin) {
  throw new Error("Approved-origin API preflight failed.");
}
if (!/authorization/iu.test(allowedPreflight.headers.get("access-control-allow-headers") || "")) {
  throw new Error("Approved-origin API preflight does not allow bearer authorization.");
}
if (!/DELETE/iu.test(allowedPreflight.headers.get("access-control-allow-methods") || "")) {
  throw new Error("Approved-origin API preflight does not allow account deletion.");
}
const deniedPreflight = await fetch(`${api}/progress`, {
  method: "OPTIONS",
  headers: { origin: "https://not-aniilogs.invalid", "access-control-request-method": "PUT" },
});
if (deniedPreflight.headers.has("access-control-allow-origin")) {
  throw new Error("Unapproved origin received an access-control-allow-origin header.");
}
checks.push("allowed_preflight", "denied_origin_preflight");

const me = await jsonResponse(`${api}/auth/me`, { headers: { origin: publicOrigin } }, 200);
if (me.payload.authenticated !== false) throw new Error("Unauthenticated auth/me response was not false.");
const progress = await jsonResponse(`${api}/progress`, { headers: { origin: publicOrigin } }, 401);
if (!/authentication required/iu.test(String(progress.payload.error || ""))) {
  throw new Error("Unauthenticated progress endpoint did not fail closed.");
}
checks.push("anonymous_identity", "owner_progress_auth_required");

const accountDeletion = await jsonResponse(`${api}/account`, {
  method: "DELETE",
  headers: { origin: publicOrigin, "content-type": "application/json" },
  body: JSON.stringify({ confirmation: "DELETE" }),
}, 401);
if (!/authentication required/iu.test(String(accountDeletion.payload.error || ""))) {
  throw new Error("Unauthenticated account deletion did not fail closed.");
}
checks.push("account_deletion_auth_required");

const returnTo = `${publicOrigin}/explorer/?view=aniilog`;
const login = await fetch(`${api}/auth/discord/start?return_to=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
if (expectOauth) {
  if (login.status < 300 || login.status >= 400) throw new Error(`OAuth start returned ${login.status}, expected a redirect.`);
  const location = new URL(login.headers.get("location") || "");
  if (location.origin !== "https://discord.com" || location.pathname !== "/oauth2/authorize") {
    throw new Error("OAuth start did not redirect to Discord's authorization endpoint.");
  }
  if (location.searchParams.get("scope") !== "identify") throw new Error("Discord OAuth scope is not exactly identify.");
  if (location.searchParams.get("redirect_uri") !== `${api}/auth/discord/callback`) {
    throw new Error("Discord OAuth callback does not match the live API origin.");
  }
  if (!location.searchParams.get("state")) throw new Error("Discord OAuth start omitted state.");
  checks.push("discord_oauth_start");
} else {
  if (login.status !== 503) throw new Error(`Unconfigured OAuth start returned ${login.status}, expected 503.`);
  checks.push("discord_oauth_disabled_fail_closed");
}

const badShare = await jsonResponse(`${api}/v1/shares/not-valid`, {}, 404);
if (!/not found/iu.test(String(badShare.payload.error || ""))) throw new Error("Invalid share ID did not fail closed.");
checks.push("invalid_share_id_rejected");

if (!skipPublicConfig) {
  const configResponse = await fetch(`${publicOrigin}/explorer/app-config.js`, { redirect: "manual" });
  if (!configResponse.ok) throw new Error(`Public app config returned ${configResponse.status}.`);
  const config = await configResponse.text();
  if (!config.includes(JSON.stringify(api))) {
    throw new Error(`Public app config is not pinned to ${api}.`);
  }
  checks.push("public_site_api_origin");
}

const report = {
  status: "pass",
  checkedAt: new Date().toISOString(),
  apiOrigin,
  publicOrigin,
  oauthConfigured: expectOauth,
  publicConfigChecked: !skipPublicConfig,
  checks,
};
if (reportPath) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
