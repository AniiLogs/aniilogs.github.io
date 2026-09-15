import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const configText = await readFile(resolve(root, "wrangler.jsonc"), "utf8");
const workerSource = await readFile(resolve(root, "src", "index.js"), "utf8");
const migration = await readFile(resolve(root, "migrations", "0003_auth_handoffs.sql"), "utf8");
const liveSmoke = await readFile(resolve(root, "scripts", "validate-live-api.mjs"), "utf8");
const privacy = await readFile(resolve(root, "public", "privacy.html"), "utf8");
const explorerConfig = await readFile(resolve(root, "public", "explorer", "app-config.js"), "utf8");

if (!configText.includes('"name": "aniilogs-api"')) throw new Error("Pages project name changed.");
if (!configText.includes('"pages_build_output_dir": "./.pages-api-dist"')) {
  throw new Error("Pages output directory is missing.");
}
if (!configText.includes('"PUBLIC_SITE_ORIGIN": "https://aniilogs.github.io"')) {
  throw new Error("GitHub Pages origin is not pinned.");
}
if (!configText.includes('"DISCORD_CLIENT_ID": "1548899251655020634"')) {
  throw new Error("AniiLogs Discord client ID is not pinned.");
}
if (!configText.includes('"binding": "CONTENT"') || !configText.includes('"bucket_name": "aniilogs-data-prod"')) {
  throw new Error("Private release-content R2 binding is missing.");
}
if (/workers\.dev|minmax|"main"|"workers_dev"/iu.test(configText)) {
  throw new Error("Worker-only or unbranded identity leaked into Pages config.");
}
if (!migration.includes("CREATE TABLE IF NOT EXISTS auth_handoffs")) {
  throw new Error("One-time OAuth handoff migration is missing.");
}
if (!workerSource.includes("AUTH_HANDOFF_LIFETIME_SECONDS = 5 * 60")) {
  throw new Error("One-time OAuth handoff lifetime changed.");
}
if (!workerSource.includes('headers.set("access-control-allow-origin", origin)')) {
  throw new Error("Exact-origin CORS response contract is missing.");
}
for (const requiredCheck of ["discord_oauth_start", "denied_origin_preflight", "public_site_api_origin"]) {
  if (!liveSmoke.includes(requiredCheck)) throw new Error(`Live deployment smoke check is missing: ${requiredCheck}`);
}
if (!workerSource.includes('url.pathname === "/api/account" && request.method === "DELETE"')) {
  throw new Error("Authenticated account deletion route is missing.");
}
if (!workerSource.includes('body.confirmation !== "DELETE"')) {
  throw new Error("Account deletion confirmation gate is missing.");
}
if (!workerSource.includes('CONTENT_PATH_PREFIX = `/api/content/releases/${CONTENT_RELEASE}/`')) {
  throw new Error("Package-pinned R2 content gateway is missing.");
}
if (!explorerConfig.includes("contentAvailable: isLocalPreview")) {
  throw new Error("Explorer production content is not fail-closed behind the localhost preview gate.");
}
if (explorerConfig.includes("aniilogs-api.pages.dev/api/content/releases/")) {
  throw new Error("Explorer production config exposes an unreviewed release-content route.");
}
if (!workerSource.includes('env.CONTENT_RELEASE_ENABLED || ""')) {
  throw new Error("R2 content gateway is not fail-closed behind explicit release approval.");
}
if (!privacy.includes("Profiles are private by default") || !privacy.includes("Deleting your account")) {
  throw new Error("Public privacy and deletion disclosure is missing.");
}
await stat(resolve(root, "migrations", "0001_discord_accounts.sql"));
await stat(resolve(root, "migrations", "0002_progress_and_shares.sql"));

console.log(JSON.stringify({
  status: "pass",
  project: "aniilogs-api",
  intendedOrigin: "https://aniilogs-api.pages.dev",
  publicSiteOrigin: "https://aniilogs.github.io",
  remoteDeploymentApproved: false,
}));
