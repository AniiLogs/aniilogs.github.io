// Uploads the map link cards' map pictures (scripts/build-map-card-bases.mjs) to the API, one PUT a map:
//   node tools/upload-map-card-bases.mjs <folder with <map id>.png files> [--only map-id,map-id] [--dry-run]
// Needs an administrator's (or the owner's) AniiLogs desktop token (alb_...): the ALOGS_DEV_TOKEN environment variable,
// or the first line of ~/.aniilogs/dev-token. The token is never printed. ALOGS_API picks another API (default: live).
// The API keeps them under the content release it serves (map-card-bases/<release>/<map id>.png): build and upload
// again after a content release changes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = (process.env.ALOGS_API || "https://aniilogs-api.pages.dev/api").replace(/\/+$/u, "");
const TOKEN_FILE = join(process.env.USERPROFILE || homedir(), ".aniilogs", "dev-token");
const token = (process.env.ALOGS_DEV_TOKEN || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "")).split(/\r?\n/u)[0].trim();
const [folder, ...rest] = process.argv.slice(2);
const dryRun = rest.includes("--dry-run");
const onlyAt = rest.indexOf("--only");
const only = onlyAt >= 0 ? new Set(String(rest[onlyAt + 1] || "").split(",")) : null;

if (!folder || !existsSync(folder)) {
  console.error("usage: node tools/upload-map-card-bases.mjs <folder> [--only map-id,map-id] [--dry-run]");
  process.exit(1);
}
if (!token && !dryRun) {
  console.error(`No developer token: set ALOGS_DEV_TOKEN or put it in ${TOKEN_FILE}.`);
  process.exit(1);
}
const names = readdirSync(folder).filter((name) => /^[a-z0-9-]{1,80}\.png$/u.test(name) && (!only || only.has(name.slice(0, -4)))).sort();
let sent = 0; let failed = 0; let bytes = 0;
for (const name of names) {
  const body = readFileSync(join(folder, name));
  bytes += body.length;
  if (dryRun) { console.log(`${name} ${body.length} bytes (not sent)`); continue; }
  const response = await fetch(`${API}/admin/map-card-bases/${name.slice(0, -4)}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "image/png" }, body,
  });
  const answer = await response.json().catch(() => ({}));
  if (response.ok) { sent += 1; console.log(`${name} stored: ${answer.width}x${answer.height}`); } else { failed += 1; console.error(`${name} ${response.status}: ${answer.error || "failed"}`); }
}
console.log(`${dryRun ? "would send" : "sent"} ${dryRun ? names.length : sent} of ${names.length} map pictures, ${(bytes / 1024 / 1024).toFixed(1)} MB${failed ? `, ${failed} failed` : ""}`);
process.exitCode = failed ? 1 : 0;
