import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Saved settings carried from the old address (aniilogs.github.io, scripts/forwarder/forward.js) to the site
// (public/carry-in.js) in the #fragment, once per browser.
const forwardSource = await readFile(new URL("../scripts/forwarder/forward.js", import.meta.url), "utf8");
const carrySource = await readFile(new URL("../public/carry-in.js", import.meta.url), "utf8");
const OLD = "https://aniilogs.github.io";
const SITE = "https://aniilogs.app";

class Storage {
  constructor(entries = {}) { this.map = new Map(Object.entries(entries)); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  toObject() { return Object.fromEntries(this.map); }
}

const globals = { TextEncoder, TextDecoder, Blob, Response, CompressionStream, DecompressionStream, atob, btoa, URL, console: { info() {} } };

// runs forward.js on an old-address page; resolves with the address it forwards to
function forward({ storage, path = "/explorer/", search = "", hash = "", carry = true }) {
  return new Promise((resolveUrl, reject) => {
    const window = {
      localStorage: storage,
      location: { pathname: path, search, hash, replace: (url) => resolveUrl(url) },
    };
    const document = { currentScript: { hasAttribute: (name) => carry && name === "data-carry" } };
    try { vm.runInNewContext(forwardSource, { window, document, ...globals }); } catch (error) { reject(error); }
    setTimeout(() => reject(new Error("forward.js never forwarded")), 4000);
  });
}

// runs carry-in.js on the site at that address; returns what it did
async function arrive(url, { storage = new Storage(), referrer = `${OLD}/` } = {}) {
  const parsed = new URL(url);
  const calls = { replaced: null, reloaded: 0 };
  const window = {
    localStorage: storage,
    location: { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash, hostname: parsed.hostname, reload: () => { calls.reloaded += 1; } },
    history: { state: null, replaceState: (_state, _title, to) => { calls.replaced = to; } },
  };
  vm.runInNewContext(carrySource, { window, document: { referrer }, ...globals });
  await new Promise((done) => setTimeout(done, 200));                 // a compressed carry unpacks asynchronously
  return { storage, calls, api: window.AniilogsCarry };
}

const SETTINGS = {
  "aniilogs:explorer:preferences:v1": JSON.stringify({ theme: "pawney", language: "de-DE", developerMode: false }),
  "aniilogs:explorer:completed:v1": JSON.stringify({ chest: ["a", "b"] }),
  "aniilogs:explorer:tracking:v1:1234567890": JSON.stringify({ pins: [1, 2, 3] }),
  "aniilogs:team-builder:v1": "{\"teams\":[]}",
  "aniilogs:color-mode:v1": "dark",
  "minmax-map:preferences:v1": "{}",
};
const SECRET = { "aniilogs:auth:session:v1": "x".repeat(64), "aniilogs:handoff": "y", "other-site:thing": "z" };

test("the site's settings travel once, the sign-in token never; they arrive where nothing is saved yet", async () => {
  const old = new Storage({ ...SETTINGS, ...SECRET });
  const url = await forward({ storage: old, search: "?view=aniilog" });
  assert.match(url, /^https:\/\/aniilogs\.app\/explorer\/\?view=aniilog#carry=j[A-Za-z0-9_-]+$/u);
  assert.equal(old.getItem("aniilogs-carried"), "1");
  const { storage, calls } = await arrive(url);
  assert.deepEqual(storage.toObject(), SETTINGS);
  assert.equal(calls.replaced, "/explorer/?view=aniilog", "carry= leaves the address");
  // once only: the next visit forwards plainly
  assert.equal(await forward({ storage: old, path: "/leaderboard/" }), `${SITE}/leaderboard/`);
});

test("newer data on the site is never overwritten", async () => {
  const url = await forward({ storage: new Storage(SETTINGS) });
  const here = new Storage({ "aniilogs:explorer:preferences:v1": "{\"theme\":\"meadow\"}" });
  const { storage } = await arrive(url, { storage: here });
  assert.equal(storage.getItem("aniilogs:explorer:preferences:v1"), "{\"theme\":\"meadow\"}");
  assert.equal(storage.getItem("aniilogs:team-builder:v1"), SETTINGS["aniilogs:team-builder:v1"]);
});

test("the #fragment stays as it was: a page's own, and aLogs' sign-in hand-off (then nothing is carried)", async () => {
  const withAnchor = await forward({ storage: new Storage(SETTINGS), path: "/guides/", hash: "#t=abc" });
  assert.match(withAnchor, /^https:\/\/aniilogs\.app\/guides\/#t=abc&carry=j/u);
  assert.equal((await arrive(withAnchor)).calls.replaced, "/guides/#t=abc");

  const old = new Storage(SETTINGS);
  const handoff = await forward({ storage: old, hash: "#aniilogs_auth=abcdefghijklmnopqrstuvwxyz0123456789" });
  assert.equal(handoff, `${SITE}/explorer/#aniilogs_auth=abcdefghijklmnopqrstuvwxyz0123456789`);
  assert.equal(old.getItem("aniilogs-carried"), null, "a later visit still carries");
  const arrived = await arrive(handoff);
  assert.equal(arrived.calls.replaced, null, "nothing to take off");
  assert.deepEqual(arrived.storage.toObject(), {});
});

test("404.html (any other address, /lb/<code>) forwards without carrying", async () => {
  const old = new Storage(SETTINGS);
  assert.equal(await forward({ storage: old, path: "/lb/abcde", carry: false }), `${SITE}/lb/abcde`);
  assert.equal(old.getItem("aniilogs-carried"), null);
});

test("the site refuses a carry naming the sign-in, from another address, malformed or too big", async () => {
  const pack = (object) => `j${Buffer.from(JSON.stringify(object)).toString("base64url")}`;
  // a link someone made by hand: the sign-in key is dropped, the rest only from the old address
  const crafted = `${SITE}/#carry=${pack({ v: 1, k: { "aniilogs:auth:session:v1": "stolen", "aniilogs:color-mode:v1": "light", "x:y": "1" } })}`;
  assert.deepEqual((await arrive(crafted)).storage.toObject(), { "aniilogs:color-mode:v1": "light" });
  const elsewhere = await arrive(crafted, { referrer: "https://evil.example/" });
  assert.deepEqual(elsewhere.storage.toObject(), {});
  assert.equal(elsewhere.calls.replaced, "/", "still taken off the address");
  assert.deepEqual((await arrive(crafted, { referrer: "" })).storage.toObject(), {});
  for (const payload of ["j", "j!!!", "q" + "a".repeat(10), pack({ v: 2, k: { "aniilogs:a": "1" } }), pack({ v: 1, k: ["aniilogs:a"] }),
    `j${Buffer.from("{not json").toString("base64url")}`, pack({ v: 1, k: { "aniilogs:a": 5 } }), `j${"A".repeat(1536 * 1024 + 4)}`,
    pack({ v: 1, k: { "aniilogs:big": "x".repeat(2 * 1024 * 1024) } })]) {
    const result = await arrive(`${SITE}/leaderboard/#carry=${payload}`);
    assert.deepEqual(result.storage.toObject(), {}, payload.slice(0, 30));
    assert.equal(result.calls.replaced, "/leaderboard/");
  }
  // a local preview may forward to itself (the browser test), nothing else local
  const local = `http://127.0.0.1:8788/#carry=${pack({ v: 1, k: { "aniilogs:color-mode:v1": "light" } })}`;
  assert.equal((await arrive(local, { referrer: "http://127.0.0.1:8790/" })).storage.getItem("aniilogs:color-mode:v1"), "light");
  assert.equal((await arrive(`${SITE}/#carry=${pack({ v: 1, k: { "aniilogs:a": "1" } })}`, { referrer: "http://127.0.0.1:8790/" })).storage.length, 0);
});

test("large settings go compressed (the page opens once more); what can't fit stays behind, the rest goes", async () => {
  const big = { ...SETTINGS, "aniilogs:explorer:completed:v1:99": JSON.stringify({ ids: Array.from({ length: 120000 }, (_, i) => `chest-${i % 500}`) }) };
  const url = await forward({ storage: new Storage(big) });
  assert.match(url, /#carry=z[A-Za-z0-9_-]+$/u);
  assert.ok(url.length < 1024 * 1024 + 100);
  const arrived = await arrive(url);
  assert.deepEqual(arrived.storage.toObject(), big);
  assert.equal(arrived.calls.reloaded, 1);

  const random = { ...SETTINGS, "aniilogs:huge": randomBytes(1024 * 1024).toString("base64") };
  const partial = await forward({ storage: new Storage(random) });
  const kept = await arrive(partial);
  assert.deepEqual(kept.storage.toObject(), SETTINGS, "everything but the one too large");

  // over the site's 2 MB unpacked limit, however well it compresses: stays behind too
  const roomy = { ...SETTINGS, "aniilogs:roomy": "a".repeat(2 * 1024 * 1024 + 10) };
  assert.deepEqual((await arrive(await forward({ storage: new Storage(roomy) }))).storage.toObject(), SETTINGS);
});

test("both ends use the same key rule", () => {
  const rule = (source) => /function carried\(key\) \{([\s\S]*?)\n  \}/u.exec(source)[1].trim();
  assert.equal(rule(forwardSource), rule(carrySource));
  const window = { location: { hash: "" } };
  vm.runInNewContext(carrySource, { window, document: { referrer: "" }, ...globals });
  const { carried } = window.AniilogsCarry;
  for (const key of Object.keys(SETTINGS)) assert.equal(carried(key), true, key);
  for (const key of [...Object.keys(SECRET), "aniilogs:session", "aniilogs:Token", "aniilogs-carried", "x".repeat(300)]) assert.equal(carried(key), false, key);
});
