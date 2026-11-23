import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import worker, { browserWriteAllowed, safeClientReturnTo, siteContentSecurityPolicy, siteOriginAllowed } from "../src/index.js";
import { siteRoutes } from "../scripts/site-routes.mjs";
import { buildForwarder, forwardingPage, NEW_ORIGIN, publicPath } from "../scripts/build-github-forwarder.mjs";

// The site moved to https://aniilogs.app (served with the API by the Cloudflare Pages project); aniilogs.github.io
// forwards there. The API stays on https://aniilogs-api.pages.dev (Discord's registered redirect address).
const SITE_CONTENT_SECURITY_POLICY = siteContentSecurityPolicy();
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const publicRoot = new URL("../public/", import.meta.url);
const SITE = "https://aniilogs.app";
const OLD = "https://aniilogs.github.io";
const API = "https://aniilogs-api.pages.dev";

// Cloudflare Pages' _routes.json rule: "*" matches anything (slashes too); exclude wins over include
const matches = (rule, path) => new RegExp(`^${rule.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(path);
const reachesWorker = ({ include, exclude }, path) => include.some((rule) => matches(rule, path)) && !exclude.some((rule) => matches(rule, path));

test("the worker module exports only functions (workerd refuses to start on any other named export)", async () => {
  const module = await import("../src/index.js");
  for (const [name, value] of Object.entries(module)) {
    if (name !== "default") assert.equal(typeof value, "function", name);
  }
});

test("_routes.json: the site's files skip the worker; the API, /lb, /a, /m and root placement codes reach it", async () => {
  const routes = await siteRoutes(publicRoot);
  assert.deepEqual(routes.include, ["/*"]);
  assert.ok(routes.include.length + routes.exclude.length <= 100, "Pages allows 100 rules");
  for (const path of ["/api/health", "/api/content/releases/3535596/assets/icons/x.png", "/api/leaderboard/interlink",
    "/lb", "/lb/", "/lb/abcde", "/lb/home", "/a/pawney", "/m/abcdefgh", "/abcde", "/23xyz/", "/no-such-page"]) {
    assert.equal(reachesWorker(routes, path), true, path);
  }
  for (const path of ["/", "/index.html", "/styles.css", "/app.js", "/theme-shell.js", "/favicon.ico", "/robots.txt",
    "/sitemap.xml", "/privacy.html", "/privacy", "/404.html", "/explorer", "/explorer/", "/explorer/app-config.js",
    "/explorer/vendor/three.module.js", "/leaderboard/", "/leaderboard/share.js", "/guides/", "/companion/",
    "/updates/3989635/", "/icons/og-card.png"]) {
    assert.equal(reachesWorker(routes, path), false, path);
  }
  for (const rule of routes.exclude) assert.doesNotMatch(rule, /^\/(?:api|lb|a|m)(?:\/|$)/u, rule);
});

test("public/_headers: the worker's site policy, letter for letter, on every static file; noindex on the API's host", async () => {
  const headers = await read("../public/_headers");
  const block = headers.split(/\n(?=\S)/u).find((part) => part.startsWith("/*\n"));
  assert.ok(block, "a /* block");
  const policy = /^\s+Content-Security-Policy: (.+)$/mu.exec(block)?.[1];
  assert.equal(policy, SITE_CONTENT_SECURITY_POLICY);
  for (const line of ["Referrer-Policy: strict-origin-when-cross-origin", "X-Content-Type-Options: nosniff", "X-Frame-Options: DENY",
    "Permissions-Policy: camera=(), microphone=(), geolocation=()"]) assert.ok(block.includes(`  ${line}`), line);
  assert.match(headers, /^https:\/\/aniilogs-api\.pages\.dev\/\*\n\s+X-Robots-Tag: noindex$/mu);
  // what the pages need: the API, Discord avatars, the game's CDN images, the 3D viewer's frame
  for (const part of ["connect-src 'self' blob: https://api.github.com https://aniilogs-api.pages.dev", "frame-src https://aniilogs-renderer-qa-3634150.pages.dev",
    "img-src 'self' data: blob: https://aniilogs-api.pages.dev https://cdn.discordapp.com", "frame-ancestors 'none'", "object-src 'none'"]) {
    assert.ok(SITE_CONTENT_SECURITY_POLICY.includes(part), part);
  }
});

test("a site page the worker hands out (a mistyped address) gets the site's policy", async () => {
  const env = { ASSETS: { fetch: async () => new Response("<!doctype html>", { status: 404, headers: { "content-type": "text/html" } }) } };
  const response = await worker.fetch(new Request(`${SITE}/no-such-page`), env);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-security-policy"), SITE_CONTENT_SECURITY_POLICY);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
});

test("the API accepts the site on https://aniilogs.app and, while it forwards, on aniilogs.github.io", async () => {
  const env = { PUBLIC_SITE_ORIGIN: SITE };
  for (const origin of [SITE, OLD]) {
    assert.equal(siteOriginAllowed(origin, env), true, origin);
    const preflight = await worker.fetch(new Request(`${API}/api/progress`, { method: "OPTIONS", headers: { origin } }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(browserWriteAllowed(new Request(`${API}/api/auth/exchange`, { method: "POST", headers: { origin, "sec-fetch-site": "cross-site" } }), env), true, origin);
  }
  for (const origin of ["https://evil.example", "https://aniilogs.app.evil.example", "http://aniilogs.app", "", null]) {
    assert.equal(siteOriginAllowed(origin, env), false, String(origin));
  }
  const denied = await worker.fetch(new Request(`${API}/api/progress`, { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("sign-in comes back to the site on aniilogs.app, a page on the old address to the same page there", () => {
  const env = { PUBLIC_SITE_ORIGIN: SITE };
  const request = new Request(`${API}/api/auth/discord/start`);
  assert.equal(safeClientReturnTo(`${SITE}/leaderboard/?mode=sim#x`, request, env), `${SITE}/leaderboard/?mode=sim#x`);
  assert.equal(safeClientReturnTo(`${OLD}/explorer/?view=aniilog`, request, env), `${SITE}/explorer/?view=aniilog`);
  assert.equal(safeClientReturnTo("https://evil.example/x", request, env), `${SITE}/`);
  assert.equal(safeClientReturnTo("/guides/", request, env), `${SITE}/guides/`);
});

test("/lb/<name> goes to the boards on aniilogs.app", async () => {
  const response = await worker.fetch(new Request(`${SITE}/lb/sim`), { PUBLIC_SITE_ORIGIN: SITE });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${SITE}/leaderboard/?mode=sim`);
});

test("configuration: PUBLIC_SITE_ORIGIN and links on aniilogs.app, the API on its own host from the site", async () => {
  const wrangler = await read("../wrangler.jsonc");
  assert.match(wrangler, /"PUBLIC_SITE_ORIGIN": "https:\/\/aniilogs\.app"/u);
  assert.match(wrangler, /"LINK_ORIGIN": "https:\/\/aniilogs\.app"/u);
  const config = await read("../public/explorer/app-config.js");
  const configFor = (hostname) => {
    const window = { location: { hostname, origin: `${hostname === "localhost" ? "http" : "https"}://${hostname}${hostname === "localhost" ? ":8788" : ""}` } };
    vm.runInNewContext(config, { window, Object });
    return window.ANIILOGS_CONFIG;
  };
  for (const hostname of ["aniilogs.app", "aniilogs.github.io", "aniilogs-api.pages.dev"]) {
    assert.equal(configFor(hostname).apiUrl, `${API}/api`, hostname);
    assert.equal(configFor(hostname).linkOrigin, SITE, hostname);
  }
  assert.equal(configFor("localhost").apiUrl, "http://localhost:8788/api");
});

test("no page names aniilogs.github.io any more (GitHub's own repository and release links aside)", async () => {
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:html|js|css|xml|txt|json)$|^_headers$/u.test(entry.name)) files.push(path);
    }
  };
  await walk(publicRoot);
  for (const file of files) {
    if (file.pathname.endsWith("/carry-in.js")) continue;   // it accepts settings from the old address (test/carry.test.js)
    const text = (await readFile(file, "utf8")).replaceAll("github.com/AniiLogs/aniilogs.github.io", "").replaceAll("repos/AniiLogs/aniilogs.github.io", "");
    assert.doesNotMatch(text, /aniilogs\.github\.io/u, file.pathname);
  }
  assert.match(await read("../public/robots.txt"), /^Sitemap: https:\/\/aniilogs\.app\/sitemap\.xml$/mu);
  assert.doesNotMatch(await read("../public/sitemap.xml"), /github\.io/u);
  assert.match(await read("../public/index.html"), /<link rel="canonical" href="https:\/\/aniilogs\.app\/">/u);
  assert.match(await read("../public/companion/index.html"), /github\.com\/AniiLogs\/aniilogs\.github\.io\/releases\/latest\/download\//u);
});

test("the github.io forwarder: one page per site page, 404.html for the rest, same path + query + #fragment", async () => {
  const output = await mkdtemp(join(tmpdir(), "aniilogs-forwarder-"));
  try {
    const written = await buildForwarder({ output });
    for (const path of ["/", "/explorer/", "/leaderboard/", "/guides/", "/companion/", "/privacy.html", "/updates/3989635/", "/404.html"]) {
      assert.ok(written.includes(path), path);
    }
    const page = (file) => readFile(join(output, file), "utf8");
    const forwardJs = await page("forward.js");
    // the page's <script src="/forward.js"> with nothing saved in this browser (test/carry.test.js: with settings)
    const forwardsTo = async (file, href) => {
      const url = new URL(href);
      const html = await page(file);
      const tag = /<script src="\/forward\.js"( data-carry)?><\/script>/u.exec(html);
      assert.ok(tag, file);
      const storage = { length: 0, key: () => null, getItem: () => null, setItem() {} };
      return new Promise((done) => vm.runInNewContext(forwardJs, {
        window: { localStorage: storage, location: { pathname: url.pathname, search: url.search, hash: url.hash, replace: done } },
        document: { currentScript: { hasAttribute: (name) => Boolean(tag[1]) && name === "data-carry" } },
        TextEncoder, Blob, Response, CompressionStream, btoa, console,
      }));
    };
    assert.equal(await forwardsTo("index.html", `${OLD}/?profile=abc#aniilogs_auth=xyz`), `${SITE}/?profile=abc#aniilogs_auth=xyz`);
    assert.equal(await forwardsTo("leaderboard/index.html", `${OLD}/leaderboard/?mode=sim`), `${SITE}/leaderboard/?mode=sim`);
    assert.equal(await forwardsTo("404.html", `${OLD}/lb/abcde`), `${SITE}/lb/abcde`);
    assert.equal(await forwardsTo("404.html", `${OLD}/explorer/app-config.js?v=1`), `${SITE}/explorer/app-config.js?v=1`);
    const home = await page("index.html");
    assert.match(home, /<link rel="canonical" href="https:\/\/aniilogs\.app\/">/u);
    assert.match(home, /<noscript><meta http-equiv="refresh" content="0; url=https:\/\/aniilogs\.app\/"><\/noscript>/u);
    assert.match(home, /<script src="\/forward\.js" data-carry><\/script>/u);
    assert.match(await page("404.html"), /<script src="\/forward\.js"><\/script>/u, "404.html (and /lb/<code>) carries nothing");
    assert.match(forwardJs, /const SITE = "https:\/\/aniilogs\.app";/u);
    assert.match(home, /<meta property="og:title" content="AniiLogs/u);
    assert.match(home, /<meta property="og:image" content="https:\/\/aniilogs\.app\/icons\/og-card\.png">/u);
    assert.match(home, /<meta name="twitter:card" content="summary_large_image">/u);
    assert.match(home, /<meta property="og:url" content="https:\/\/aniilogs\.app\/">/u);
    assert.ok(home.indexOf("<script") < home.indexOf('http-equiv="refresh"'), "the script (keeps the query) comes first");
    assert.match(await page("privacy.html"), /<link rel="canonical" href="https:\/\/aniilogs\.app\/privacy">/u);
    assert.match(await page("404.html"), /<meta name="robots" content="noindex">/u);
    // Search Console's ownership file for the old address stays as it is
    const verification = (await readdir(output)).find((name) => /^google[0-9a-f]+\.html$/u.test(name));
    assert.equal(await page(verification), await readFile(new URL(verification, publicRoot), "utf8"));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
  assert.equal(NEW_ORIGIN, SITE);
  assert.equal(publicPath(join("updates", "3989635", "index.html")), "/updates/3989635/");
  // 404.html has no address of its own to refresh to (without a script it only says where the site went)
  assert.doesNotMatch(forwardingPage({ notFound: true }), /http-equiv|rel="canonical"/u);
});
