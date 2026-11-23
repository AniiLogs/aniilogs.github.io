import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// The site's short links (/lb/<code>, /lb/home ...) are the worker's on https://aniilogs.app (src/placement-links.js,
// test/placement-links.test.js); GitHub Pages' 404 trick (short-link.js + not-found.js) is gone with the move.
const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const notFoundHtml = await read("../public/404.html");
const boardsHtml = await read("../public/leaderboard/index.html");
const shareJs = await read("../public/leaderboard/share.js");

test("short-link.js and not-found.js are gone, and no page loads them", async () => {
  for (const file of ["../public/short-link.js", "../public/not-found.js"]) {
    await assert.rejects(access(new URL(file, import.meta.url)), file);
  }
  assert.doesNotMatch(notFoundHtml + boardsHtml, /short-link\.js|not-found\.js/u);
  assert.doesNotMatch(shareJs, /AniilogsShortLink|shortBase/u);
});

test("404.html: absolute paths only, noindex, a plain Page not found", () => {
  const refs = [...notFoundHtml.matchAll(/\s(?:src|href)="([^"]*)"/gu)].map((match) => match[1]);
  assert.ok(refs.length > 5);
  for (const ref of refs) assert.match(ref, /^\//u, `${ref} must be an absolute path: the page is served at any address`);
  assert.match(notFoundHtml, /<meta name="robots" content="noindex">/u);
  assert.match(notFoundHtml, /<title>Page not found — AniiLogs<\/title>/u);
  assert.match(notFoundHtml, /<h1 data-not-found-title>Page not found<\/h1>/u);
  assert.doesNotMatch(notFoundHtml, /site-chrome|app-topbar/u);
});

test("share.js: <linkOrigin>/lb/<code> when the site names its link domain, the API's own link without one", async () => {
  const run = async (linkOrigin, answer) => {
    const sent = [];
    const window = {
      location: { hostname: "aniilogs.app" },
      ANIILOGS_CONFIG: { apiUrl: "https://api.example.test/api", ...(linkOrigin === undefined ? {} : { linkOrigin }) },
      setTimeout: () => 0, clearTimeout: () => {},
    };
    const copied = [];
    const button = () => ({ dataset: {}, listeners: {}, append() {}, prepend() {}, setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
    const document = { createElement: () => ({ ...button(), remove() {}, set textContent(v) { this.text = v; }, get textContent() { return this.text || ""; } }) };
    const navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
    const fetch = async (url, init) => { sent.push([url, init.method]); return { ok: true, json: async () => answer }; };
    vm.runInNewContext(shareJs, { window, document, navigator, fetch, URL });
    const known = window.AniilogsShare.button({ code: "abcde" });
    await known.listeners.click({ stopPropagation() {} });
    const made = window.AniilogsShare.button({ run: "run-12345678", ladder: "score" });
    await made.listeners.click({ stopPropagation() {} });
    return { copied, sent };
  };
  const answer = { code: "fghjk", url: "https://api.example.test/fghjk" };
  assert.deepEqual(await run("https://aniilogs.app", answer),
    { copied: ["https://aniilogs.app/lb/abcde", "https://aniilogs.app/lb/fghjk"], sent: [["https://api.example.test/api/links", "POST"]] });
  assert.deepEqual((await run("", answer)).copied, ["https://api.example.test/abcde", "https://api.example.test/fghjk"]);
  assert.deepEqual((await run(undefined, answer)).copied, ["https://api.example.test/abcde", "https://api.example.test/fghjk"]);
  // an answer without a usable code: the API's own url
  assert.deepEqual((await run("https://aniilogs.app", { url: "https://api.example.test/fghjk" })).copied,
    ["https://aniilogs.app/lb/abcde", "https://api.example.test/fghjk"]);
  assert.match(shareJs, /fetch\(`\$\{API_URL\}\/links`, \{ method: "POST", credentials: "omit"/u);
});
