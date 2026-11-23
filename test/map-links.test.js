// Map pin links: https://aniilogs.app/m/<code> (src/map-links.js, migration 0039), their cards (src/placement-card.js
// drawMapCard) and the map's Share button (public/explorer/app.js). The maps and pins here are made up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { crc32, deflateSync } from "node:zlib";

import worker from "../src/index.js";
import { canonicalSelection, LONG_LINK_LIMIT, MAP_LINK_LIMITS, MAX_PINS_PARAM, pinPoints, pinsParam } from "../src/map-links.js";
import { validShareSelection } from "../src/index.js";
import { CARD_ATLAS, CARD_ATLAS_BYTES, CARD_FONTS } from "../src/card-glyphs.js";
import { decodePng, drawMapCard, MAP_BASE_SCALE, MAP_CARD_BOX } from "../src/placement-card.js";

const LETTERS = { atlas: CARD_ATLAS, atlasBytes: CARD_ATLAS_BYTES, fonts: CARD_FONTS };
const ORIGIN = "https://aniilogs.github.io";
const API = "https://api.aniilogs.example";
const RELEASE = "3535596";
const DISCORD_UA = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAPS = { maps: [
  { id: "test-meadow", label: "Test Meadow", world_label: "Idyll", width: 4000, height: 3000 },
  { id: "test-cave", label: "Test Cave — Underground", world_label: "Idyll", width: 1000, height: 1000 },
] };

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const DB = { prepare: (sql) => ({ ...statement(sql), bind: (...values) => statement(sql, values) }), async batch(list) { return Promise.all(list.map((item) => item.run())); } };
  const content = new Map([[`releases/${RELEASE}/data/map_site_data.json`, Buffer.from(JSON.stringify(MAPS))]]);
  const CONTENT = {
    async get(key) {
      const bytes = content.get(key);
      return bytes ? { body: new Uint8Array(bytes), size: bytes.length, writeHttpMetadata: (headers) => headers.set("content-type", "application/json") } : null;
    },
    async head(key) { return content.has(key) ? {} : null; },
  };
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body) { objects.set(key, new Uint8Array(await new Response(body).arrayBuffer())); },
    async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
    async head(key) { return objects.has(key) ? {} : null; },
  };
  const env = { DB, CONTENT, EVIDENCE, CONTENT_RELEASE_ENABLED: "true", PUBLIC_SITE_ORIGIN: ORIGIN, LINK_ORIGIN: "https://aniilogs.app",
    SESSION_SECRET: "a-test-secret-that-is-long-enough-123", ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  return { env, sqlite, objects };
}
function call(env, path, { method = "GET", body, origin = ORIGIN, ua = BROWSER_UA, ip = "203.0.113.7" } = {}) {
  const headers = new Headers({ "user-agent": ua, "cf-connecting-ip": ip });
  if (origin) headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
const PINS = { m: "test-meadow", g: [["item-1"], ["item-2", "s", ["test-meadow::item-2::K1::Thing"]]] };
const POINTS = [1000, 2000, 5000, 5000, 9999, 0];
const create = (env, selection = PINS, extra = {}) => call(env, "/api/map-links", { method: "POST", body: { version: 1, selection, count: 3, points: POINTS, ...extra } });
const meta = (html, property) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`, "u").exec(html)?.[1] ?? null;

// the map's own reader of ?pins= (public/explorer/app.js), run as the browser runs it
function mapParser() {
  const app = readFileSync(new URL("../public/explorer/app.js", import.meta.url), "utf8");
  const source = app.slice(app.indexOf("function decodeBase64Url("), app.indexOf("function formatNumber("));
  const context = { window: { atob: (value) => Buffer.from(value, "base64").toString("latin1") }, TextDecoder, Uint8Array,
    SHARED_PINS_VERSION: 1, MAX_SHARED_PINS_PAYLOAD_LENGTH: 24000 };
  vm.runInNewContext(`${source}\nthis.parse = parseSharedPinSelection;`, context);
  return (value) => JSON.parse(JSON.stringify(context.parse(value)));
}

test("the pins in one spelling; a payload the map wouldn't read is refused; the dots are whole numbers 0..9999", () => {
  assert.deepEqual(canonicalSelection({ m: "a", g: [["x"], ["y", "s"]] }, validShareSelection), { m: "a", g: [["x"], ["y", "s", []]] });
  assert.equal(canonicalSelection({ m: "a", g: [["x", "a"]] }, validShareSelection), null);          // the API's own rule
  assert.equal(canonicalSelection({ m: "a", g: [[""]] }, validShareSelection), null);
  assert.equal(canonicalSelection({ m: "a", g: [] }, validShareSelection), null);
  assert.equal(canonicalSelection({ m: "a", g: [["x", "q"]] }, validShareSelection), null);
  assert.equal(canonicalSelection({ m: "", g: [["x"]] }, validShareSelection), null);
  assert.deepEqual(pinPoints(undefined), []);
  assert.deepEqual(pinPoints([0, 9999]), [0, 9999]);
  for (const bad of [[1], [0, 10000], [-1, 0], [0.5, 1], "1,2", new Array(3002).fill(1)]) assert.equal(pinPoints(bad), null);
});

test("the long form is the one the map reads: the API's ?pins= value parses back to the same pins in the map's own code", () => {
  const parse = mapParser();
  const value = pinsParam(PINS);
  assert.match(value, /^v1\.[A-Za-z0-9_-]+$/u);
  assert.deepEqual(parse(value), { mapId: "test-meadow", groups: [{ itemId: "item-1", mode: "a", spawnIds: [] },
    { itemId: "item-2", mode: "s", spawnIds: ["test-meadow::item-2::K1::Thing"] }] });
  const accents = { m: "test-meadow", g: [["ítem·ü", "x", ["名前"]]] };
  assert.equal(parse(pinsParam(accents)).groups[0].spawnIds[0], "名前");
});

test("making a link: a 5-letter code on aniilogs.app; the same pins give the same code; other pins another", async () => {
  const { env, sqlite } = setup();
  const first = await create(env);
  assert.equal(first.status, 201);
  const made = await first.json();
  assert.match(made.code, /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u);
  assert.equal(made.url, `https://aniilogs.app/m/${made.code}`);
  const again = await create(env, JSON.parse(JSON.stringify(PINS)), { count: 99, points: [] });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).code, made.code);
  // the same pins with a group spelt shorter: still the same pins
  const spelt = await create(env, { m: "test-meadow", g: [["item-1"], ["item-2", "s", ["test-meadow::item-2::K1::Thing"]]] });
  assert.equal((await spelt.json()).code, made.code);
  const other = await (await create(env, { m: "test-meadow", g: [["item-3"]] })).json();
  assert.notEqual(other.code, made.code);
  const row = sqlite.prepare("SELECT map_id, pin_count, points_json, ip_hash FROM map_links WHERE code = ?").get(made.code);
  assert.equal(row.map_id, "test-meadow"); assert.equal(row.pin_count, 3); assert.deepEqual(JSON.parse(row.points_json), POINTS);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(row.ip_hash, /203/u);
});

test("making a link: only from the site, only the map's pins on a map the site has, within the size cap", async () => {
  const { env } = setup();
  assert.equal((await call(env, "/api/map-links", { method: "POST", origin: "https://elsewhere.example", body: { version: 1, selection: PINS } })).status, 403);
  assert.equal((await call(env, "/api/map-links", { method: "POST", origin: null, body: { version: 1, selection: PINS } })).status, 403);
  assert.equal((await create(env, { m: "nowhere", g: [["x"]] })).status, 400);
  assert.equal((await create(env, { m: "test-meadow", g: [["x", "s", [42]]] })).status, 400);
  assert.equal((await create(env, PINS, { version: 2 })).status, 400);
  assert.equal((await create(env, PINS, { points: [1, 2, 3] })).status, 400);
  // under the body cap but more than the map's ?pins= limit
  const many = { m: "test-meadow", g: [["item", "s", Array.from({ length: 900 }, (_, i) => `test-meadow::item::K${i}::A long made-up pin name`)]] };
  assert.ok(pinsParam(many).length > MAX_PINS_PARAM);
  assert.equal((await create(env, many, { points: [] })).status, 413);
  const huge = { m: "test-meadow", g: [["item", "s", Array.from({ length: 4000 }, (_, i) => `id-${i}-${"x".repeat(20)}`)]] };
  assert.ok(JSON.stringify(huge).length > MAP_LINK_LIMITS.bodyBytes);
  assert.equal((await create(env, huge, { points: [] })).status, 413);
});

test("limits: a network makes at most 30 new links an hour (old ones still answer); its mark is wiped after a day", async () => {
  const { env, sqlite } = setup();
  for (let i = 0; i < MAP_LINK_LIMITS.perNetworkHour; i += 1) assert.equal((await create(env, { m: "test-meadow", g: [[`item-${i}`]] })).status, 201);
  const refused = await create(env, { m: "test-meadow", g: [["one-more"]] });
  assert.equal(refused.status, 429);
  assert.equal((await create(env, { m: "test-meadow", g: [["item-0"]] })).status, 200);                    // already made
  assert.equal((await call(env, "/api/map-links", { method: "POST", ip: "198.51.100.9", body: { version: 1, selection: { m: "test-meadow", g: [["one-more"]] } } })).status, 201);
  sqlite.prepare("UPDATE map_links SET created_at = created_at - 90000").run();
  assert.equal((await create(env, { m: "test-meadow", g: [["after-a-day"]] })).status, 201);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM map_links WHERE ip_hash != ''").get().n, 1);
});

test("opening a link: a person goes to the map with ?pins= (or ?pinlink= when too long); the API hands the pins to the map", async () => {
  const { env } = setup();
  const { code } = await (await create(env)).json();
  const opened = await call(env, `/m/${code}`);
  assert.equal(opened.status, 302);
  const location = new URL(opened.headers.get("location"));
  assert.equal(`${location.origin}${location.pathname}`, `${ORIGIN}/explorer/`);
  assert.equal(mapParser()(location.searchParams.get("pins")).mapId, "test-meadow");
  assert.equal((await call(env, `/M/${code.toUpperCase()}/`)).headers.get("location"), opened.headers.get("location"));
  const long = { m: "test-meadow", g: [["item", "s", Array.from({ length: 200 }, (_, i) => `test-meadow::item::K${i}::Pin`)]] };
  assert.ok(pinsParam(long).length > LONG_LINK_LIMIT);
  const longCode = (await (await create(env, long, { points: [] })).json()).code;
  assert.equal((await call(env, `/m/${longCode}`)).headers.get("location"), `${ORIGIN}/explorer/?pinlink=${longCode}`);
  const read = await call(env, `/api/map-links/${longCode}`);
  assert.equal(read.status, 200);
  assert.deepEqual((await read.json()).selection, long);
  assert.equal((await call(env, "/api/map-links/zzzzz")).status, 404);
  // unknown and malformed codes
  assert.equal((await call(env, "/m/zzzzz")).headers.get("location"), `${ORIGIN}/explorer/?pinlink=zzzzz`);
  assert.equal((await call(env, "/m/not-a-code")).headers.get("location"), `${ORIGIN}/explorer/`);
  assert.equal((await call(env, "/m/zzzzz", { ua: DISCORD_UA })).status, 404);
  assert.equal((await call(env, `/m/${code}`, { method: "POST" })).status, 404);
});

test("a crawler gets the preview: how many pins on which map, the link on aniilogs.app, and the card with the map once it's there", async () => {
  const { env, objects } = setup();
  const { code } = await (await create(env)).json();
  const html = await (await call(env, `/m/${code}`, { ua: DISCORD_UA })).text();
  assert.equal(meta(html, "og:title"), "3 pins on Test Meadow");
  assert.equal(meta(html, "og:description"), "3 pins of 2 kinds on Test Meadow, Idyll. Open them on the AniiLogs interactive map.");
  assert.equal(meta(html, "og:url"), `https://aniilogs.app/m/${code}`);
  const image = new URL(meta(html, "og:image"));
  assert.equal(image.pathname, `/api/map-links/${code}.png`);
  const card = await call(env, `${image.pathname}${image.search}`);
  assert.equal(card.status, 200);
  assert.match(card.headers.get("cache-control"), /immutable/u);
  assert.equal((await decodePng(new Uint8Array(await card.arrayBuffer()))).width, 1200);
  assert.equal([...objects.keys()].filter((key) => key.startsWith(`map-cards/${code}-`)).length, 1);
  // the map's picture arrives: a new look (new hash), drawn and kept again
  const w = Math.floor(MAP_CARD_BOX.width / MAP_BASE_SCALE); const h = Math.floor(MAP_CARD_BOX.height / MAP_BASE_SCALE) - 30;
  const indices = Uint8Array.from({ length: w * h }, (_, i) => (i % w < w / 2 ? 0 : 1));
  objects.set(`map-card-bases/${RELEASE}/test-meadow.png`, new Uint8Array(palettePng(w, h, indices, [[40, 120, 60], [30, 80, 160]])));
  const html2 = await (await call(env, `/m/${code}`, { ua: DISCORD_UA })).text();
  assert.notEqual(meta(html2, "og:image"), meta(html, "og:image"));
  const image2 = new URL(meta(html2, "og:image"));
  assert.equal((await call(env, `${image2.pathname}${image2.search}`)).status, 200);
  assert.equal([...objects.keys()].filter((key) => key.startsWith(`map-cards/${code}-`)).length, 2);
  // one pin: said so
  const one = await (await create(env, { m: "test-cave", g: [["solo"]] }, { count: 1, points: [5000, 5000] })).json();
  const html3 = await (await call(env, `/m/${one.code}`, { ua: DISCORD_UA })).text();
  assert.equal(meta(html3, "og:title"), "1 pin on Test Cave — Underground");
});

test("storing a map picture needs an administrator", async () => {
  const { env } = setup();
  const response = await call(env, "/api/admin/map-card-bases/test-meadow", { method: "PUT", body: "x" });
  assert.equal(response.status, 403);
});

function palettePng(width, height, indices, palette) {
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name, "latin1"), Buffer.from(data)]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 3, 0, 0, 0], 8);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("PLTE", Buffer.from(palette.flat())),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("the map card draws with and without the map's picture, any number of pins, long names cut", async () => {
  const w = 300; const h = 200;
  const base = await decodePng(palettePng(w, h, Uint8Array.from({ length: w * h }, (_, i) => i % 3), [[10, 20, 30], [200, 180, 90], [40, 140, 70]]));
  const many = Array.from({ length: 3000 }, (_, i) => (i * 7919) % 10000);
  for (const model of [
    { count: 0, map: "Test Meadow", points: [] },
    { count: 1, map: "Test Meadow", world: "Idyll", kinds: 1, aspect: 4 / 3, points: [0, 0] },
    { count: 123456, map: "A made-up map with a very long name that needs three lines or more to show it", world: "Idyll", kinds: 9, aspect: 0.5, points: many },
    { count: 2, map: "", points: [5000, 5000, 20000, -5] },
  ]) {
    for (const picture of [base, null]) {
      const png = await drawMapCard(model, LETTERS, picture);
      const read = await decodePng(png);
      assert.equal(read.width, 1200); assert.equal(read.height, 630);
    }
  }
});

test("the map's Share button makes the short link, copies it on aniilogs.app, and falls back to the long ?pins= link", () => {
  const app = readFileSync(new URL("../public/explorer/app.js", import.meta.url), "utf8");
  assert.match(app, /fetch\(`\$\{API_URL\}\/map-links`, \{\s+method: "POST",/u);
  assert.match(app, /if \(LINK_ORIGIN\) return `\$\{LINK_ORIGIN\}\/m\/\$\{body\.code\}`;/u);
  assert.match(app, /if \(!link\) link = longSharedPinUrl\(selection\);/u);
  assert.match(app, /url\.searchParams\.set\(SHARED_PINS_PARAM, value\);/u);
  assert.match(app, /const PIN_LINK_PARAM = "pinlink";/u);
  assert.match(app, /fetch\(`\$\{API_URL\}\/map-links\/\$\{REQUESTED_PIN_LINK_CODE\}`/u);
  // the old links still load: ?pins= and the 3-hour ?s=
  assert.match(app, /const REQUESTED_SHARED_PIN_SELECTION = parseSharedPinSelection\(INITIAL_URL_PARAMS\.get\(SHARED_PINS_PARAM\)\);/u);
  assert.match(app, /apiFetch\(`\/v1\/shares\/\$\{REQUESTED_SHORT_SHARE_ID\}`/u);
  assert.doesNotMatch(app, /3-hour link copied/u);
});
