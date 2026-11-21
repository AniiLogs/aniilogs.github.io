// Placement links (src/placement-links.js, migration 0037), the Solo / Duo / Trio label and the ?players= filter on
// the Interlink boards, and the share card (src/placement-card.js). Every player here is made up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import test from "node:test";

import worker from "../src/index.js";
import { realPlayersOf, TEAM_TAGS } from "../src/placement-links.js";
import { CARD_ATLAS, CARD_ATLAS_BYTES, CARD_FONTS } from "../src/card-glyphs.js";
import { CARD_HEIGHT, CARD_WIDTH, drawPlacementCard } from "../src/placement-card.js";

const LETTERS = { atlas: CARD_ATLAS, atlasBytes: CARD_ATLAS_BYTES, fonts: CARD_FONTS };

const ORIGIN = "https://aniilogs.github.io";
const API = "https://api.aniilogs.example";
const BOSS = { id: "80000100", name: "Omega Tucking", level: 60 };
const DISCORD_UA = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const DB = {
    prepare(sql) {
      return { ...statement(sql), bind: (...values) => {
        if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
        return statement(sql, values);
      } };
    },
    async batch(statements) { return Promise.all(statements.map((item) => item.run())); },
  };
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body, options) { objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), type: options?.httpMetadata?.contentType }); },
    async get(key) {
      const object = objects.get(key);
      return object ? { body: object.bytes, writeHttpMetadata: (headers) => headers.set("content-type", object.type) } : null;
    },
    async delete(key) { objects.delete(key); },
  };
  const ASSETS = { fetch: async () => new Response("Not found", { status: 404 }) };      // the API root's static files
  const env = { DB, EVIDENCE, ASSETS, PUBLIC_SITE_ORIGIN: ORIGIN, LEADERBOARD_PUBLIC: "true" };
  return { env, sqlite };
}

function call(env, path, { session, token, method = "GET", body, form, ua, origin } = {}) {
  const headers = new Headers();
  if (session) { headers.set("authorization", `Bearer ${session}`); headers.set("origin", ORIGIN); }
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (origin) headers.set("origin", origin);
  if (ua) headers.set("user-agent", ua);
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers.set("content-type", "application/json"); payload = JSON.stringify(body); }
  return worker.fetch(new Request(`${API}${path}`, { method, headers, body: payload }), env);
}

// a made-up player: an account with a desktop token and a linked character
let nextId = 0;
async function player(env, sqlite, name) {
  nextId += 1;
  const discordId = String(400000000000000000n + BigInt(nextId));
  const session = `s${String(nextId).padStart(3, "0")}`.padEnd(48, "x");
  const now = Math.floor(Date.now() / 1000);
  sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(discordId, name.toLowerCase(), name, now, now);
  sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(discordId, name, now, now);
  sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(session), discordId, now, now + 3600);
  const made = await call(env, "/api/leaderboard/tokens", { session, method: "POST", body: { label: "PC" } });
  assert.equal(made.status, 201);
  const { token } = await made.json();
  const gameUid = String(302000000000 + nextId);
  assert.equal((await call(env, "/api/leaderboard/characters", { token, method: "POST", body: { gameUid, name } })).status < 300, true);
  return { name, token, gameUid };
}

// one run's copy, sent with its proof picture. party: [name, ai?, avgDps]; the sender is marked self
async function send(env, who, id, { score, stars = 30, party, at = 0, clearTimeS = 170 }) {
  const players = party.map(([name, ai = false, avgDps]) => ({ name, ai, ...(name === who.name ? { self: true } : {}), ...(avgDps ? { avgDps } : {}) }));
  const body = { kind: "interlink_run", clientRunId: id, cycle: "3005", boss: BOSS, score, stars, clearTimeS, cleared: true, teamDps: 60000,
    gameUid: who.gameUid, playedAt: 1792700000 + at, players,
    extra: { lineup: party.map(([name, ai = false], slot) => ({ slot: slot + 1, name, ai, ...(name === who.name ? { self: true } : {}) })) } };
  const form = new FormData();
  form.set("submission", JSON.stringify(body));
  form.set("evidence", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], { type: "image/jpeg" }), "result.jpg");
  const response = await call(env, "/api/leaderboard/submissions", { token: who.token, method: "POST", form });
  assert.ok(response.status === 201 || response.status === 200, `sent ${id}: ${response.status}`);
}
const idOf = (sqlite, clientRunId) => sqlite.prepare("SELECT submission_id AS id FROM leaderboard_submissions WHERE client_run_id = ?").get(clientRunId).id;

// The board: a Solo (place 1), a Duo sent by both its players (2), a full team of four (3), a Trio (4), another Solo (5)
async function board() {
  const { env, sqlite } = await setup();
  const p = {};
  for (const name of ["Aster", "Briar", "Cobalt", "Dorian", "Ember", "Fenwick"]) p[name] = await player(env, sqlite, name);
  await send(env, p.Aster, "solo", { score: 30000, party: [["Aster", false, 30000], ["Bot One", true], ["Bot Two", true], ["Bot Three", true]], at: 0 });
  const duo = [["Briar", false, 21000], ["Cobalt", false, 26000], ["Bot One", true], ["Bot Two", true]];
  await send(env, p.Briar, "duo-b", { score: 25000, party: duo, at: 600 });
  await send(env, p.Cobalt, "duo-c", { score: 25000, party: duo, at: 610 });
  await send(env, p.Dorian, "four", { score: 20000, party: [["Dorian", false, 9000], ["Quill", false], ["Rowan", false], ["Sorrel", false]], at: 1200 });
  await send(env, p.Ember, "trio", { score: 15000, party: [["Ember", false, 7000], ["Tansy", false], ["Umber", false], ["Bot One", true]], at: 1800 });
  await send(env, p.Fenwick, "solo-2", { score: 10000, party: [["Fenwick", false, 6000], ["Bot One", true], ["Bot Two", true], ["Bot Three", true]], at: 2400 });
  return { env, sqlite, p };
}
const interlink = async (env, query) => (await (await call(env, `/api/leaderboard/interlink?cycle=3005&boss=${BOSS.id}&${query}`)).json()).bosses[0];
const createLink = (env, body, origin = ORIGIN) => call(env, "/api/links", { method: "POST", body, origin });

test("the label rule: four real players none, three Trio, two Duo, one Solo; no bots, no label", () => {
  const seat = (ai, name = "Someone") => ({ name, ai });
  assert.equal(realPlayersOf([seat(false), seat(false), seat(false), seat(false)]), null);
  assert.equal(realPlayersOf([seat(false), seat(false), seat(false), seat(true)]), 3);
  assert.equal(realPlayersOf(JSON.stringify([seat(false), seat(false), seat(true), seat(true)])), 2);
  assert.equal(realPlayersOf([seat(false), seat(true), seat(true), seat(true)]), 1);
  assert.equal(realPlayersOf([seat(false), seat(false)]), null);                 // nothing says bots were there
  assert.equal(realPlayersOf(null), null);
  assert.deepEqual([TEAM_TAGS[1], TEAM_TAGS[2], TEAM_TAGS[3]], ["Solo", "Duo", "Trio"]);
});

test("board rows carry the label; ?players= hides rows but every row keeps its overall place, and pages what's left", async () => {
  const { env } = await board();
  const all = await interlink(env, "ladder=score&rows=teams");
  assert.deepEqual(all.entries.map((e) => [e.player, e.rank, e.realPlayers ?? 4]),
    [["Aster", 1, 1], ["Cobalt", 2, 2], ["Briar", 2, 2], ["Dorian", 3, 4], ["Ember", 4, 3], ["Fenwick", 5, 1]]);
  assert.deepEqual([all.teams, all.total], [5, 6]);
  const duos = await interlink(env, "ladder=score&rows=teams&players=2");
  assert.deepEqual(duos.entries.map((e) => [e.player, e.rank]), [["Cobalt", 2], ["Briar", 2]]);
  assert.deepEqual([duos.teams, duos.total], [1, 2]);
  const solos = await interlink(env, "ladder=score&rows=teams&players=1");
  assert.deepEqual(solos.entries.map((e) => e.rank), [1, 5]);              // 1, 5: the places on the whole ladder
  const second = await interlink(env, "ladder=score&rows=teams&players=1&limit=1&offset=1");
  assert.deepEqual(second.entries.map((e) => [e.player, e.rank]), [["Fenwick", 5]]);
  assert.equal(second.teams, 2);                                              // "View all" counts what the filter leaves
  const four = await interlink(env, "ladder=score&players=4");
  assert.deepEqual(four.entries.map((e) => [e.player, e.rank]), [["Dorian", 3]]);
  // Players view and a one-player ladder filter the same way
  const dps = await interlink(env, "ladder=dps&players=1");
  assert.deepEqual(dps.entries.map((e) => [e.player, e.rank]), [["Aster", 1], ["Fenwick", 6]]);
  // no filter: the answer is as before
  assert.equal((await interlink(env, "ladder=score&players=7")).total, 6);
});

test("links: the same placement gives one code, from either copy of the run; a run not on a board gets none", async () => {
  const { env, sqlite } = await board();
  const first = await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" });
  assert.equal(first.status, 200);
  const { code, url } = await first.json();
  assert.match(code, /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u);
  assert.equal(url, `${API}/${code}`);
  assert.equal((await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" })).json()).code, code);
  assert.equal((await (await createLink(env, { run: idOf(sqlite, "duo-c"), ladder: "score" })).json()).code, code);
  // another ladder is another placement
  const clear = (await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "clear" })).json()).code;
  assert.notEqual(clear, code);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM placement_links").get().n, 2);
  // a one-player ladder: one link per player of the run
  const briar = (await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps", player: "Briar" })).json()).code;
  const cobalt = (await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps", player: "cobalt" })).json()).code;
  assert.notEqual(briar, cobalt);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps" })).status, 400);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "dps", player: "Nobody" })).status, 404);
  // not on a board: unknown, hidden, or a teammate's name the default board leaves out
  assert.equal((await createLink(env, { run: "unknownrun123", ladder: "score" })).status, 404);
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'trio'").run();
  assert.equal((await createLink(env, { run: idOf(sqlite, "trio"), ladder: "score" })).status, 404);
  assert.equal((await createLink(env, { run: idOf(sqlite, "four"), ladder: "dps", player: "Quill" })).status, 404);
  // bad input and other sites
  assert.equal((await createLink(env, { run: "../x", ladder: "score" })).status, 400);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "taken" })).status, 400);
  assert.equal((await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" }, "https://elsewhere.example")).status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM placement_links").get().n, 4);
});

test("opening a link: a crawler gets the preview tags with the overall place; a person goes to the boards with the run open", async () => {
  const { env, sqlite } = await board();
  const duo = idOf(sqlite, "duo-c");
  const { code } = await (await createLink(env, { run: duo, ladder: "score" })).json();
  const page = await call(env, `/${code}`, { ua: DISCORD_UA });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/u);
  const html = await page.text();
  const tag = (property) => html.match(new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`, "u"))?.[1];
  assert.equal(tag("og:site_name"), "AniiLogs");
  assert.match(tag("og:title"), /^#2 on Score · Omega Tucking · Week of [A-Z][a-z]{2} \d{1,2} – [A-Z][a-z]{2} \d{1,2}$/u);
  assert.match(html, /<title>#2 on Score · Omega Tucking · .* · AniiLogs<\/title>/u);
  assert.match(tag("og:description"), /^Cobalt and Briar \(Duo: bots filled the other places\): 25,000 with 30 stars\. Boss Killed: 2:50\. Team DPS 60,000\. Holo-Battle Interlink/u);
  assert.equal(tag("og:url"), `${API}/${code}`);
  assert.equal(tag("twitter:card"), "summary_large_image");
  assert.equal(tag("theme-color"), "#f5eecb");
  assert.match(tag("og:image"), new RegExp(`^${API}/api/links/${code}\\.png\\?p=2&amp;v=[0-9a-f]{16}$`, "u"));
  assert.equal(tag("og:image:width"), "1200");
  assert.equal(tag("og:image:height"), "630");
  // a person
  const person = await call(env, `/${code}`, { ua: BROWSER_UA });
  assert.equal(person.status, 302);
  const target = new URL(person.headers.get("location"));
  assert.equal(target.origin + target.pathname, `${ORIGIN}/leaderboard/`);
  assert.equal(target.searchParams.get("run"), duo);
  assert.equal(target.searchParams.get("ladder"), "score");
  assert.equal(target.searchParams.get("week"), "3005");
  assert.equal(target.searchParams.get("boss"), BOSS.id);
  assert.equal(target.searchParams.get("rows"), "teams");
  assert.equal(target.searchParams.get("link"), code);
  assert.equal(target.searchParams.has("offset"), false);
  // the place is the overall one, read when the link is opened: a better run sent later moves this one down
  const gale = await player(env, sqlite, "Gale");
  await send(env, gale, "better", { score: 40000, party: [["Gale", false, 40000], ["Bot One", true], ["Bot Two", true], ["Bot Three", true]], at: 3000 });
  const later = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  assert.match(later, /<meta property="og:title" content="#3 on Score/u);
  assert.match(later, /\.png\?p=3&amp;v=/u);
});

test("opening a link: an unknown code, a run gone from the boards and a malformed path", async () => {
  const { env, sqlite } = await board();
  const { code } = await (await createLink(env, { run: idOf(sqlite, "trio"), ladder: "score" })).json();
  for (const ua of [DISCORD_UA, BROWSER_UA]) {
    const unknown = await call(env, "/zzzzz", { ua });
    assert.equal(unknown.status, 404);
    const text = await unknown.text();
    assert.match(text, /This run isn't available/u);
    assert.match(text, /href="https:\/\/aniilogs\.github\.io\/leaderboard\/"/u);
    assert.doesNotMatch(text, /error|exception|stack/iu);
  }
  sqlite.prepare("UPDATE leaderboard_submissions SET status = 'hidden' WHERE client_run_id = 'trio'").run();
  assert.equal((await call(env, `/${code}`, { ua: BROWSER_UA })).status, 404);
  assert.equal((await call(env, `/api/links/${code}.png`)).status, 404);
  // look-alike letters and wrong lengths are never looked up; they aren't links
  for (const path of ["/abcd0", "/ABCDE", "/abcdef", "/a'b\"c"]) {
    const response = await call(env, path, { ua: DISCORD_UA }).catch(() => null);
    assert.ok(!response || response.status !== 200 || !(await response.text()).includes("og:title"), path);
  }
});

test("the crawler page escapes everything it writes", async () => {
  const { env, sqlite } = await setup();
  const odd = await player(env, sqlite, "Tom&Jerry");
  await send(env, odd, "odd", { score: 12000, party: [["Tom&Jerry", false, 5000], ["Bot One", true], ["Bot Two", true], ["Bot Three", true]] });
  sqlite.prepare("UPDATE game_characters SET character_name = ? WHERE character_name = 'Tom&Jerry'").run(`<script>alert("x")</script>'`);
  const { code } = await (await createLink(env, { run: idOf(sqlite, "odd"), ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  assert.doesNotMatch(html, /<script/iu);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;&#39;/u);
});

test("the card: a valid 1200x630 PNG, drawn once a look and kept, a new place drawn anew", async () => {
  const { env, sqlite } = await board();
  const { code } = await (await createLink(env, { run: idOf(sqlite, "duo-b"), ladder: "score" })).json();
  const html = await (await call(env, `/${code}`, { ua: DISCORD_UA })).text();
  const image = new URL(html.match(/<meta property="og:image" content="([^"]*)">/u)[1].replaceAll("&amp;", "&"));
  const response = await call(env, image.pathname + image.search);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.match(response.headers.get("cache-control"), /immutable/u);
  const png = new Uint8Array(await response.arrayBuffer());
  const info = pngInfo(png);
  assert.deepEqual([info.width, info.height, info.colourType, info.bitDepth], [1200, 630, 3, 8]);
  assert.equal(info.pixels.length, 630 * 1201);
  assert.ok(info.paletteSize > 8 && info.paletteSize <= 256);
  assert.deepEqual([...env.EVIDENCE.objects.keys()].filter((key) => key.startsWith("placement-cards/")), [`placement-cards/${code}/2-${image.searchParams.get("v")}.png`]);
  // kept: a second fetch reads the stored one
  env.EVIDENCE.objects.get(`placement-cards/${code}/2-${image.searchParams.get("v")}.png`).bytes = Uint8Array.from([1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await (await call(env, image.pathname + image.search)).arrayBuffer())], [1, 2, 3]);
  // a new place: a new key
  const gale = await player(env, sqlite, "Gale");
  await send(env, gale, "better", { score: 40000, party: [["Gale", false, 40000], ["Bot One", true], ["Bot Two", true], ["Bot Three", true]], at: 3000 });
  const fresh = await call(env, `/api/links/${code}.png`);
  assert.equal(pngInfo(new Uint8Array(await fresh.arrayBuffer())).width, 1200);
  assert.equal([...env.EVIDENCE.objects.keys()].filter((key) => key.startsWith(`placement-cards/${code}/3-`)).length, 1);
});

test("the card drawing: every model shape draws, names in letters the card lacks become boxes", async () => {
  const base = { place: 12, ladder: "Fastest clear", figure: "1:58", boss: "Alpha Blazen + Omega Tucking", slot: "Center",
    week: "Week of Nov 18 – Nov 25", stars: 40, result: "Both Killed: 1:58", extra: "Score 96,200", tag: "Trio" };
  for (const players of [[], [{ name: "Ålvarö Ñuñez", dps: "12,000" }], [{ name: "テスト", dps: null }, { name: "x".repeat(80), dps: "1" }]]) {
    const info = pngInfo(await drawPlacementCard({ ...base, players }, LETTERS));
    assert.deepEqual([info.width, info.height], [CARD_WIDTH, CARD_HEIGHT]);
  }
});

test("the card's name and text letter sets draw every printable ASCII character", () => {
  for (const font of ["title", "body", "small"]) {
    const missing = [];
    for (let code = 0x20; code <= 0x7e; code += 1) if (!CARD_FONTS[font].glyphs[String.fromCharCode(code)]) missing.push(String.fromCharCode(code));
    assert.deepEqual(missing, [], font);
  }
});

// a PNG's header, palette and inflated scanlines; throws on a bad signature or CRC
function pngInfo(png) {
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  let at = 8; const idat = []; const info = {};
  while (at < png.length) {
    const length = view.getUint32(at); const type = String.fromCharCode(...png.slice(at + 4, at + 8));
    let crc = 0xffffffff;
    for (let i = at + 4; i < at + 8 + length; i += 1) crc = table[(crc ^ png[i]) & 0xff] ^ (crc >>> 8);
    assert.equal((crc ^ 0xffffffff) >>> 0, view.getUint32(at + 8 + length), `${type} CRC`);
    const data = png.slice(at + 8, at + 8 + length);
    if (type === "IHDR") Object.assign(info, { width: view.getUint32(at + 8), height: view.getUint32(at + 12), bitDepth: data[8], colourType: data[9] });
    if (type === "PLTE") info.paletteSize = length / 3;
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
    if (type === "IEND") break;
  }
  info.pixels = inflateSync(Buffer.concat(idat));                 // zlib: checks the Adler-32 too
  for (let row = 0; row < info.height; row += 1) assert.equal(info.pixels[row * (info.width + 1)], 0, "filter byte");
  return info;
}

test("the boards page: the link button and tag script before the boards, the Party filter, and run links that tidy up", () => {
  const read = (path) => readFileSync(resolve(import.meta.dirname, "..", "public", path), "utf8");
  const page = read("leaderboard/index.html");
  assert.ok(page.indexOf('<script src="/leaderboard/share.js') > 0 && page.indexOf('<script src="/leaderboard/share.js') < page.indexOf('<script src="/leaderboard/leaderboard.js'));
  assert.match(page, /<select data-party-select[^>]*><option value="">All<\/option><option value="4">Four players<\/option><option value="3">Trio<\/option><option value="2">Duo<\/option><option value="1">Solo<\/option><\/select>/u);
  const boards = read("leaderboard/leaderboard.js");
  assert.match(boards, /function openRunFromUrl\(\)/u);
  assert.match(boards, /\["comments"\]\.includes\(params\.get\("tab"\)\)/u);              // an unknown tab is ignored
  assert.match(boards, /for \(const key of \["run", "tab", "link"\]\) url\.searchParams\.delete\(key\)/u);
  assert.match(boards, /if \(state\.players\) ask\.set\("players", state\.players\)/u);
  const share = read("leaderboard/share.js");
  assert.match(share, /fetch\(`\$\{API_URL\}\/links`, \{ method: "POST", credentials: "omit"/u);
  assert.match(share, /"Link copied"/u);
  assert.doesNotMatch(share, /localStorage|sessionStorage/u);
});