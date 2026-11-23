// game-audit: n/a build helper; lists the site's own files for Cloudflare Pages' _routes.json
import { readdir } from "node:fs/promises";

// The worker answers /api/*, /lb and /lb/*, /a/* and /m/* and the placement links at the root (/<5 letters>), which no
// wildcard can describe, so it is given everything ("/*") except the site's own files and folders: the home page
// ("/"), each top-level folder ("/explorer", "/explorer/*") and each top-level file ("/styles.css"; a page also
// without ".html", the address Pages serves it at). Those are served straight from the static files, never through the
// worker (each worker run counts against the free plan's daily requests). An address that is none of them (a
// mistyped page) still reaches the worker, which hands it to the static files (404.html). Pages allows 100 rules.
export const WORKER_NAMES = Object.freeze(["api", "lb", "a", "m"]);
const CODE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u;   // src/placement-links.js PLACEMENT_CODE

export async function siteRoutes(publicRoot) {
  const exclude = ["/"];
  const entries = (await readdir(publicRoot, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = entry.name;
    if (name.startsWith("_")) continue;                    // _headers: read by Pages, never served
    const bare = name.replace(/\.html$/u, "");
    if (WORKER_NAMES.includes(name.toLowerCase()) || CODE.test(name) || CODE.test(bare)) {
      throw new Error(`public/${name} would take an address the worker answers.`);
    }
    if (/[*\s]/u.test(name)) throw new Error(`public/${name}: a name _routes.json can't hold.`);
    if (entry.isDirectory()) {
      exclude.push(`/${name}`, `/${name}/*`);
    } else {
      exclude.push(`/${name}`);
      if (name.endsWith(".html") && name !== "index.html" && name !== "404.html") exclude.push(`/${bare}`);
    }
  }
  const include = ["/*"];
  if (include.length + exclude.length > 100) {
    throw new Error(`_routes.json would have ${include.length + exclude.length} rules; Pages allows 100.`);
  }
  return { version: 1, include, exclude };
}
