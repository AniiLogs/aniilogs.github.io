import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { PLACEMENT_CODE } from "../src/placement-links.js";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../public/short-link.js");
const notFoundHtml = await read("../public/404.html");
const notFoundJs = await read("../public/not-found.js");
const boardsHtml = await read("../public/leaderboard/index.html");
const shareJs = await read("../public/leaderboard/share.js");

function load() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AniilogsShortLink;
}

const API = "https://api.example.test";
const plain = (value) => (value === null ? null : JSON.parse(JSON.stringify(value)));

test("/lb/<code> is a run link to the API's /<code>, in any letter case, with or without a closing slash", () => {
  const { resolve } = load();
  const link = { kind: "link", code: "abcde", url: `${API}/abcde` };
  assert.deepEqual(plain(resolve("/lb/abcde", API)), link);
  assert.deepEqual(plain(resolve("/lb/abcde/", API)), link);
  assert.deepEqual(plain(resolve("/lb/ABCDE", API)), link);
  assert.deepEqual(plain(resolve("/LB/AbCdE/", API)), link);
  assert.deepEqual(plain(resolve("/lb/23xyz", `${API}/`)), { kind: "link", code: "23xyz", url: `${API}/23xyz` });
});

test("/lb and /lb/home open the leaderboards", () => {
  const { resolve } = load();
  for (const path of ["/lb", "/lb/", "/lb/home", "/lb/home/", "/lb/HOME/", "/LB/Home"]) {
    assert.deepEqual(plain(resolve(path, API)), { kind: "boards", url: "/leaderboard/" }, path);
  }
});

test("/lb/interlink, /lb/sim and /lb/egg open one board each, in any letter case, with or without a closing slash", () => {
  const { resolve } = load();
  const boards = { interlink: "/leaderboard/?mode=interlink", sim: "/leaderboard/?mode=sim", egg: "/leaderboard/?mode=eggheist" };
  for (const [name, url] of Object.entries(boards)) {
    for (const path of [`/lb/${name}`, `/lb/${name}/`, `/lb/${name.toUpperCase()}`, `/LB/${name.toUpperCase()}/`]) {
      assert.deepEqual(plain(resolve(path, API)), { kind: "boards", url }, path);
    }
  }
});

test("no reserved name can ever be a link code, so none hides a real link", () => {
  const { names, resolve } = load();
  assert.deepEqual([...names].sort(), ["egg", "home", "interlink", "sim"]);
  for (const name of names) {
    assert.equal(PLACEMENT_CODE.test(name), false, name);
    assert.equal(resolve(`/lb/${name}`, API).kind, "boards", name);
  }
  assert.equal(String(PLACEMENT_CODE), String(/^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u), "short-link.js copies the API's code rule");
  assert.match(source, /const CODE = \/\^\[23456789abcdefghjkmnpqrstuvwxyz\]\{5\}\$\/u;/u);
});

test("any other /lb/ address is a bad link: wrong length, a character the codes never use, more parts", () => {
  const { resolve } = load();
  for (const path of ["/lb/abcd", "/lb/abcdef", "/lb/abcd0", "/lb/abcd1", "/lb/abcdi", "/lb/abcdl", "/lb/abcdo", "/lb/ab-de", "/lb/abcde/x", "/lb//abcde", "/lb/homes"]) {
    assert.deepEqual(plain(resolve(path, API)), { kind: "bad-link" }, path);
  }
});

test("every other address is left alone", () => {
  const { resolve } = load();
  for (const path of ["/guides/nope", "/", "/lbx", "/lbabcde", "/leaderboard/", "/x/lb/abcde", "", undefined]) {
    assert.equal(resolve(path, API), null, String(path));
  }
});

test("base: the site's /lb only on aniilogs.github.io, the API's own link anywhere else", () => {
  const { base } = load();
  assert.equal(base({ hostname: "aniilogs.github.io" }), "https://aniilogs.github.io/lb");
  for (const hostname of ["127.0.0.1", "localhost", "aniilogs-api.pages.dev", ""]) assert.equal(base({ hostname }), "", hostname);
  assert.equal(base(undefined), "");
});

test("404.html: absolute paths only, noindex, short-link.js before its own script, Page not found without a script", () => {
  const refs = [...notFoundHtml.matchAll(/\s(?:src|href)="([^"]*)"/gu)].map((match) => match[1]);
  assert.ok(refs.length > 5);
  for (const ref of refs) assert.match(ref, /^\//u, `${ref} must be an absolute path: the page is served at any address`);
  assert.match(notFoundHtml, /<meta name="robots" content="noindex">/u);
  const shortAt = notFoundHtml.indexOf('<script src="/short-link.js');
  const ownAt = notFoundHtml.indexOf('<script src="/not-found.js');
  assert.ok(notFoundHtml.indexOf('<script src="/explorer/app-config.js') > 0 && shortAt > 0 && shortAt < ownAt);
  assert.match(notFoundHtml, /<title>Page not found — AniiLogs<\/title>/u);
  assert.match(notFoundHtml, /<h1 data-not-found-title>Page not found<\/h1>/u);
  assert.match(notFoundHtml, /<noscript><p>[^<]*<a href="\/leaderboard\/">/u);
  assert.doesNotMatch(notFoundHtml, /site-chrome|app-topbar/u);
  assert.match(notFoundJs, /window\.location\.replace\(target\.url\)/u);
  assert.match(notFoundJs, /new URL\(window\.ANIILOGS_CONFIG\?\.apiUrl, window\.location\.href\)\.origin/u);
});

test("the boards copy the site's /lb link: short-link.js loads before share.js, which reads the base", () => {
  const shortAt = boardsHtml.indexOf('<script src="/short-link.js?v=0.1.0"');
  const shareAt = boardsHtml.indexOf('<script src="/leaderboard/share.js?v=0.2.0-lb-links"');
  assert.ok(shortAt > 0 && shortAt < shareAt);
  assert.match(shareJs, /window\.AniilogsShortLink\?\.base\(window\.location\)/u);
  assert.match(shareJs, /fetch\(`\$\{API_URL\}\/links`, \{ method: "POST", credentials: "omit"/u);
});

test("share.js: aniilogs.github.io/lb/<code> on the site, the API's link elsewhere or without short-link.js", async () => {
  const run = async (hostname, withShortLink, answer) => {
    const sent = [];
    const window = {
      location: { hostname },
      ANIILOGS_CONFIG: { apiUrl: "https://api.example.test/api" },
      setTimeout: () => 0, clearTimeout: () => {},
    };
    if (withShortLink) vm.runInNewContext(source, { window });
    const copied = [];
    const button = () => {
      const node = { dataset: {}, listeners: {}, append() {}, prepend() {}, setAttribute() {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
      return node;
    };
    const document = { createElement: () => ({ ...button(), remove() {}, set textContent(v) { this.text = v; }, get textContent() { return this.text || ""; } }) };
    const navigator = { clipboard: { writeText: async (text) => { copied.push(text); } } };
    const fetch = async (url, init) => { sent.push([url, init.method]); return { ok: true, json: async () => answer }; };
    vm.runInNewContext(await read("../public/leaderboard/share.js"), { window, document, navigator, fetch, URL });
    const known = window.AniilogsShare.button({ code: "abcde" });
    await known.listeners.click({ stopPropagation() {} });
    const made = window.AniilogsShare.button({ run: "run-12345678", ladder: "score" });
    await made.listeners.click({ stopPropagation() {} });
    return { copied, sent };
  };
  const answer = { code: "fghjk", url: "https://api.example.test/fghjk" };
  assert.deepEqual(await run("aniilogs.github.io", true, answer),
    { copied: ["https://aniilogs.github.io/lb/abcde", "https://aniilogs.github.io/lb/fghjk"], sent: [["https://api.example.test/api/links", "POST"]] });
  assert.deepEqual((await run("127.0.0.1", true, answer)).copied, ["https://api.example.test/abcde", "https://api.example.test/fghjk"]);
  assert.deepEqual((await run("aniilogs.github.io", false, answer)).copied, ["https://api.example.test/abcde", "https://api.example.test/fghjk"]);
  // an answer without a usable code: the API's own url
  assert.deepEqual((await run("aniilogs.github.io", true, { url: "https://api.example.test/fghjk" })).copied,
    ["https://aniilogs.github.io/lb/abcde", "https://api.example.test/fghjk"]);
});
