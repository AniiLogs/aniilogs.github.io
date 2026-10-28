// Log reports sent from the aLogs app ("Send logs"), read with the wrangler login on this PC (no website session):
//   node tools/log-reports.mjs list                  newest first: id, UID, when, size, app version, note
//   node tools/log-reports.mjs get <id> [folder]     download one report's zip (default: ./log-reports)
//   node tools/log-reports.mjs clear <id> | all      delete a report (or every report) once its problem is fixed
// Without a wrangler login, a Cloudflare API token (D1 Edit + R2 Storage Edit only) is read from
// %USERPROFILE%\.aniilogs\cloudflare.env (or ~/.aniilogs/cloudflare.env): CLOUDFLARE_API_TOKEN=... and
// CLOUDFLARE_ACCOUNT_ID=... lines. That file lives outside every repository and is never printed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB = "aniilogs-prod";
const BUCKET = "aniilogs-data-prod";
const TOKEN_FILE = join(process.env.USERPROFILE || homedir(), ".aniilogs", "cloudflare.env");
const env = { ...process.env };
if (existsSync(TOKEN_FILE)) {
  for (const line of readFileSync(TOKEN_FILE, "utf8").split(/\r?\n/u)) {
    const m = line.match(/^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*=\s*"?([^"\s]+)"?\s*$/u);
    if (m) env[m[1]] = m[2];
  }
}
const wrangler = (...args) => execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...args],
  { encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"], env });
const sql = (command) => JSON.parse(wrangler("d1", "execute", DB, "--remote", "--json", "--command", JSON.stringify(command)))[0].results;
const idOk = (id) => /^[A-Za-z0-9_-]{8,40}$/u.test(id || "");

const [action, arg, folder = "log-reports"] = process.argv.slice(2);
if (action === "list") {
  for (const r of sql("SELECT report_id AS id, game_uid AS uid, created_at AS at, size_bytes AS size, app_version AS version, note FROM log_reports ORDER BY created_at DESC")) {
    console.log(`${r.id}  UID ${r.uid}  ${new Date(r.at * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC  ${(r.size / 1024).toFixed(0)} KB  ${r.version || "?"}${r.note ? `\n    ${r.note}` : ""}`);
  }
} else if (action === "get" && idOk(arg)) {
  const [row] = sql(`SELECT log_key AS key, game_uid AS uid FROM log_reports WHERE report_id = '${arg}'`);
  if (!row) throw new Error(`No report ${arg}`);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${arg}-${row.uid}.zip`);
  wrangler("r2", "object", "get", `${BUCKET}/${row.key}`, "--remote", "--file", file);
  console.log(file);
} else if (action === "clear" && (arg === "all" || idOk(arg))) {
  const rows = sql(`SELECT report_id AS id, log_key AS key FROM log_reports${arg === "all" ? "" : ` WHERE report_id = '${arg}'`}`);
  for (const row of rows) {
    wrangler("r2", "object", "delete", `${BUCKET}/${row.key}`, "--remote");
    sql(`DELETE FROM log_reports WHERE report_id = '${row.id}'`);
  }
  console.log(`cleared ${rows.length}`);
} else {
  console.log("usage: node tools/log-reports.mjs list | get <id> [folder] | clear <id>|all");
  process.exitCode = 1;
}
