// Cloudflare Web Analytics (switched on in the dashboard for aniilogs.app) adds its script to the site's pages; the
// site's policy lets that script in and lets it send the visit, and the privacy page says visits are counted.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { siteContentSecurityPolicy } from "../src/index.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the site's policy lets Cloudflare Web Analytics load and send, on static files and the worker's pages alike", () => {
  const policy = siteContentSecurityPolicy();
  assert.match(policy, /script-src 'self' https:\/\/aniilogs-api\.pages\.dev https:\/\/static\.cloudflareinsights\.com(;|$)/u);
  assert.match(policy, /connect-src [^;]* https:\/\/cloudflareinsights\.com(;|$)/u);
  assert.ok(read("public/_headers").includes(`Content-Security-Policy: ${policy}`));
});

test("the privacy page says visits are counted, with no cookies, and EU visitors aren't", () => {
  const privacy = read("public/privacy.html");
  assert.match(privacy, /Cloudflare Web Analytics, which sets no cookies/u);
  assert.match(privacy, /Visitors from the EU aren't counted\./u);
  assert.doesNotMatch(privacy, /no advertising or third-party analytics/u);
});
