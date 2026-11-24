// Aniimo links: https://aniilogs.app/a/<slug> (src/aniimo-links.js), their cards (src/placement-card.js drawAniimoCard)
// and the site's own "take me there" links (public/aniimo-link.js shortSlugs). Every Aniimo here
// is made up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { crc32, deflateSync } from "node:zlib";

import worker from "../src/index.js";
import { aniimoLinkIndex, aniimoSlugs, describeAniimo, findAniimo, slugPart } from "../src/aniimo-links.js";
import { CARD_ATLAS, CARD_ATLAS_BYTES, CARD_FONTS } from "../src/card-glyphs.js";
import { cardText, decodePng, drawAniimoCard, medianCut } from "../src/placement-card.js";
import { linkPage } from "../src/placement-links.js";

const LETTERS = { atlas: CARD_ATLAS, atlasBytes: CARD_ATLAS_BYTES, fonts: CARD_FONTS };
const ORIGIN = "https://aniilogs.github.io";
const API = "https://api.aniilogs.example";
const RELEASE = "3535596";
const DISCORD_UA = "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

// a PNG of the given colour type from raw pixels (rows unfiltered)
function pngBytes(width, height, type, pixels, palette = null) {
  const channels = { 2: 3, 3: 1, 6: 4 }[type];
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name, "latin1"), Buffer.from(data)]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, type, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(pixels.subarray(y * width * channels, (y + 1) * width * channels), y * (width * channels + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...(palette ? [chunk("PLTE", Buffer.from(palette.flat()))] : []),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
// a made-up round icon: a warm disc on a see-through square
function iconPng(size = 48) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4; const inside = Math.hypot(x - size / 2, y - size / 2) < size / 2 - 2;
      pixels.set(inside ? [220, 90 + (x % 40), 60, 255] : [0, 0, 0, 0], i);
    }
  }
  return pngBytes(size, size, 6, pixels);
}

const SKILL = (element, color) => ({ combat: { element, element_color: color } });
const ENTRIES = [
  { form_id: "9000100", name: "Testpup", form_key: "basic", form_label: "Basic Form", aniilog_number: "#900", elements: [{ name: "Fire", level: 1 }],
    role: "DPS", surface_label: "Idyll", profile: { height_m: 0.9, weight_kg: 12 }, description: "A made-up Aniimo for the tests.",
    icon: "assets/icons/testpup.png", skills: [SKILL("Fire", "#e03d3d")] },
  { form_id: "9000101", name: "Testpup", form_key: "highland", form_label: "Highland Form", aniilog_number: "#900",
    elements: [{ name: "Fire", level: 1 }, { name: "Rock", level: 1 }], role: "DPS", surface_label: "Idyll", profile: {}, description: "Lives up high.",
    icon: "assets/icons/missing.png", skills: [SKILL("Rock", "#b8a278")] },
  // a second form that would be named the same: the later form id gets its id after the name
  { form_id: "9000102", name: "Testpup", form_key: "upland", form_label: "Highland Form", aniilog_number: "#900", elements: [], role: "BREAK", skills: [] },
  // a name with no basic form: its only form's slug, and the bare name finds it too
  { form_id: "9000300", name: "Lunafox", form_key: "temporary-evolution", form_label: "Temporary evolution", aniilog_number: "",
    elements: [{ name: "Holy", level: 1 }], role: "DPS", icon: "https://example.invalid/lunafox.png", skills: [] },
  { form_id: "9000400", name: "Éclair Mon", form_key: "basic", form_label: "Basic Form", aniilog_number: "#904", elements: [], role: "SUPPORT", skills: [] },
  { form_id: "9000500", name: "Quote \"<b>\" Mon", form_key: "basic", form_label: "Basic Form", aniilog_number: "#905", elements: [], role: "HEALER",
    description: "Says <script>alert(1)</script> & more.", skills: [] },
];
// what the search page shows: the basic Testpup's stats, skills, traits, home abilities, places, evolution, research
Object.assign(ENTRIES[0], {
  stats: [{ label: "HP", value: 67 }, { label: "Attack", value: 90 }],
  skills: [{ ...SKILL("Fire", "#e03d3d"), name: "Test Bolt", group: "Skill", description: "Throws a made-up <bolt>." }],
  ultimates: [{ name: "Test Star", description: "A made-up ultimate." }],
  traits: [{ name: "Test Trait", description: "Made up too." }],
  homeland: [{ name: "Hauling", description: "Carries things home." }],
  explore_ability: { name: "Hustle" },
  locations: [{ map_label: "Test Plains", areas: ["North Field", "South Field"] }],
  evolution: { from: [], to: [{ id: "aniimo:9000400" }] },
  aniilog_research: [{ name: "Test Research", objective: "Take a photo of Testpup." }],
});
const DATA = { entries: ENTRIES, element_labels: { Fire: "Fire", Rock: "Earth", Holy: "Light" } };

function setup({ data = DATA, icon = iconPng(), env: extra = {} } = {}) {
  const content = new Map([[`releases/${RELEASE}/data/aniilog_data.json`, Buffer.from(JSON.stringify(data))],
    [`releases/${RELEASE}/assets/icons/testpup.png`, icon]]);
  const reads = [];
  const object = (bytes, type) => ({ body: new Uint8Array(bytes), size: bytes.length, httpEtag: "\"t\"", writeHttpMetadata: (headers) => headers.set("content-type", type) });
  const CONTENT = {
    async get(key) { reads.push(key); const bytes = content.get(key); return bytes ? object(bytes, key.endsWith(".png") ? "image/png" : "application/json") : null; },
    async head(key) { const bytes = content.get(key); return bytes ? object(bytes, "x") : null; },
  };
  const objects = new Map();
  const EVIDENCE = {
    objects,
    async put(key, body, options) { objects.set(key, { bytes: new Uint8Array(await new Response(body).arrayBuffer()), type: options?.httpMetadata?.contentType }); },
    async get(key) { const kept = objects.get(key); return kept ? { body: kept.bytes } : null; },
    async head(key) { return objects.has(key) ? {} : null; },
  };
  const env = { CONTENT, EVIDENCE, CONTENT_RELEASE_ENABLED: "true", PUBLIC_SITE_ORIGIN: ORIGIN, LINK_ORIGIN: "https://aniilogs.app",
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...extra };
  return { env, reads, objects };
}
const call = (env, path, { ua = BROWSER_UA, method = "GET" } = {}) => worker.fetch(new Request(`${API}${path}`, { method, headers: { "user-agent": ua } }), env);
const meta = (html, property) => new RegExp(`<meta (?:property|name)="${property}" content="([^"]*)">`, "u").exec(html)?.[1] ?? null;

test("slugs: the name in lower case, a form adds its name, a taken slug its form id, a name without a basic form finds its form", () => {
  assert.equal(slugPart("Éclair Mon"), "eclair-mon");
  assert.equal(slugPart("  Mr. & Mrs.  "), "mr-and-mrs");
  const { slugs, aliases } = aniimoSlugs(ENTRIES);
  assert.deepEqual(Object.fromEntries(slugs), {
    9000100: "testpup", 9000101: "testpup-highland", 9000102: "testpup-highland-9000102",
    9000300: "lunafox-temporary-evolution", 9000400: "eclair-mon", 9000500: "quote-b-mon",
  });
  assert.deepEqual(Object.fromEntries(aliases), { lunafox: "9000300" });
  // the same whatever order the entries come in (forms are named in form id order)
  assert.deepEqual(aniimoSlugs([...ENTRIES].reverse()).slugs, slugs);
  // slugs are only letters, digits and single hyphens
  for (const slug of slugs.values()) assert.match(slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
});

test("aniimo-link.js makes the same slugs as the API (public/aniimo-link.js shortSlugs)", () => {
  const window = { location: { pathname: "/explorer/" } };
  const document = { head: { append() {} }, createElement: () => ({}), getElementById: () => null };
  vm.runInNewContext(readFileSync(new URL("../public/aniimo-link.js", import.meta.url), "utf8"), { window, document, encodeURIComponent });
  const mixed = [...ENTRIES, { form_id: "9000600", name: "Testpup", form_key: "night", form_label: "Nighttime Form" }, { form_id: "x", name: "Bad" }];
  assert.deepEqual(Object.fromEntries(window.AniilogsAniimoLink.shortSlugs(mixed)), Object.fromEntries(aniimoSlugs(mixed).slugs));
});

test("the index: facts from the release, its own art only, element colours from the skills", () => {
  const index = aniimoLinkIndex(DATA, RELEASE);
  assert.equal(index.release, RELEASE);
  const pup = index.forms.find((form) => form.id === "9000101");
  assert.deepEqual(pup.elements, [{ label: "Fire", color: "#e03d3d" }, { label: "Earth", color: "#b8a278" }]);
  assert.equal(index.forms.find((form) => form.id === "9000300").icon, "");
  assert.equal(findAniimo(index, "TestPup%20Highland").id, "9000101");
  assert.equal(findAniimo(index, "9000102").slug, "testpup-highland-9000102");
  assert.equal(findAniimo(index, "lunafox").id, "9000300");
  assert.equal(findAniimo(index, "nobody"), null);
  assert.equal(findAniimo(index, ""), null);
  const { title, description, card } = describeAniimo(index.forms[0]);
  assert.equal(title, "Testpup");
  assert.equal(description, "Fire · DPS · Basic Form · Aniilog #900. A made-up Aniimo for the tests.");
  assert.deepEqual(card.facts, ["0.9 m · 12 kg · Idyll"]);
  assert.equal(describeAniimo(pup).title, "Testpup · Highland Form");
});

test("a person is sent to the form's Aniilog page; any spelling, a form id or a bare name finds it; anything else the Aniilog", async () => {
  const { env } = setup();
  const to = async (path) => { const response = await call(env, path); assert.equal(response.status, 302, path); return response.headers.get("location"); };
  assert.equal(await to("/a/testpup"), `${ORIGIN}/explorer/?aniimo=9000100`);
  assert.equal(await to("/a/TestPup/"), `${ORIGIN}/explorer/?aniimo=9000100`);
  assert.equal(await to("/a/testpup-highland"), `${ORIGIN}/explorer/?aniimo=9000101`);
  assert.equal(await to("/A/9000102"), `${ORIGIN}/explorer/?aniimo=9000102`);
  assert.equal(await to("/a/lunafox"), `${ORIGIN}/explorer/?aniimo=9000300`);
  assert.equal(await to("/a/%C3%A9clair%20mon"), `${ORIGIN}/explorer/?aniimo=9000400`);
  assert.equal(await to("/a/nobody"), `${ORIGIN}/explorer/?view=aniilog`);
  assert.equal(await to("/a"), `${ORIGIN}/explorer/?view=aniilog`);
  assert.equal((await call(env, "/a/testpup", { method: "POST" })).status, 404);
  // a crawler asking for an unknown Aniimo is sent on too
  assert.equal((await call(env, "/a/nobody", { ua: DISCORD_UA })).status, 302);
});

test("a crawler gets the preview: the name, short facts, the link on aniilogs.app and the card; everything escaped", async () => {
  const { env } = setup();
  const response = await call(env, "/a/testpup-highland", { ua: DISCORD_UA });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(meta(html, "og:title"), "Testpup · Highland Form");
  assert.equal(meta(html, "og:description"), "Fire / Earth · DPS · Highland Form · Aniilog #900. Lives up high.");
  assert.equal(meta(html, "og:url"), "https://aniilogs.app/a/testpup-highland");
  assert.match(meta(html, "og:image"), /^https:\/\/api\.aniilogs\.example\/api\/aniimo-cards\/testpup-highland\.png\?v=[0-9a-f]{16}$/u);
  assert.equal(meta(html, "twitter:card"), "summary_large_image");
  assert.doesNotMatch(meta(html, "og:url"), /dev/u);         // the game's chat hides "dev"
  const odd = await (await call(env, "/a/quote-b-mon", { ua: DISCORD_UA })).text();
  assert.doesNotMatch(odd, /<script>|<b>/u);
  assert.match(odd, /Quote &quot;&lt;b&gt;&quot; Mon/u);
});

test("search engines get the Aniimo's page: indexed, canonical on aniilogs.app, with the Aniilog's facts; link previews too", async () => {
  const { env } = setup();
  const google = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  const bing = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
  for (const ua of [google, bing, DISCORD_UA]) assert.equal((await call(env, "/a/testpup", { ua })).status, 200, ua);
  const html = await (await call(env, "/a/testpup", { ua: google })).text();
  assert.doesNotMatch(html, /noindex/u);
  assert.match(html, /<link rel="canonical" href="https:\/\/aniilogs\.app\/a\/testpup">/u);
  assert.match(html, /<title>Testpup - Aniimo stats, skills and where to find it · AniiLogs<\/title>/u);
  assert.match(html, /<img src="https:\/\/api\.aniilogs\.example\/api\/content\/releases\/3535596\/assets\/icons\/testpup\.png"/u);
  for (const words of ["<h1>Testpup</h1>", "<th>Attack</th><td>90</td>", "<strong>Test Bolt (Skill, Fire)</strong> - Throws a made-up &lt;bolt&gt;.",
    "<strong>Test Star (Ultimate)</strong>", "<strong>Test Trait</strong> - Made up too.", "<strong>Hauling</strong>", "Exploration: Hustle",
    "<strong>Test Plains</strong> - North Field, South Field", "<strong>Test Research</strong> - Take a photo of Testpup.",
    "<h2>Evolves into</h2>", `<a href="https://aniilogs.app/a/eclair-mon">Éclair Mon</a>`,
    `<a href="https://aniilogs.app/a/testpup-highland">Testpup (Highland Form)</a>`,
    `<a href="${ORIGIN}/explorer/?aniimo=9000100">Open Testpup in the 3D Aniilog</a>`]) assert.ok(html.includes(words), words);
  assert.doesNotMatch(html, /Evolves from/u);                     // no section without anything in it
  // the other short links' pages (/lb/, /m/) stay out of search results
  const other = await linkPage(200, { title: "A run", url: "https://aniilogs.app/lb/abcde", body: "" }).text();
  assert.match(other, /<meta name="robots" content="noindex">/u);
  assert.doesNotMatch(other, /canonical/u);
});

test("the Aniimo sitemap lists every form's /a/ page on aniilogs.app, and robots.txt names it", async () => {
  const { env } = setup();
  const response = await call(env, "/api/sitemap/aniimo.xml");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/xml/u);
  const locs = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
  assert.equal(locs.length, ENTRIES.length);
  assert.ok(locs.includes("https://aniilogs.app/a/testpup-highland"));
  assert.ok(locs.every((loc) => /^https:\/\/aniilogs\.app\/a\/[a-z0-9-]+$/u.test(loc)));
  assert.equal((await call(setup({ env: { CONTENT_RELEASE_ENABLED: "false" } }).env, "/api/sitemap/aniimo.xml")).status, 503);
  assert.match(readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8"), /^Sitemap: https:\/\/aniilogs\.app\/api\/sitemap\/aniimo\.xml\r?$/mu);
});

test("the index is made from the release once and kept in R2; the next isolate reads only the small copy", async () => {
  const { env, reads, objects } = setup();
  await call(env, "/a/testpup");
  const key = `link-index/aniimo-v2-${RELEASE}.json`;
  assert.ok(objects.has(key));
  assert.equal(JSON.parse(Buffer.from(objects.get(key).bytes).toString()).forms.length, ENTRIES.length);
  const before = reads.filter((read) => read.endsWith("aniilog_data.json")).length;
  await call(env, "/a/testpup-highland");
  assert.equal(reads.filter((read) => read.endsWith("aniilog_data.json")).length, before);
});

test("the card: a 1200x630 PNG with the release's art, drawn once a look and kept; art that can't be read is not kept", async () => {
  const { env, objects } = setup();
  const html = await (await call(env, "/a/testpup", { ua: DISCORD_UA })).text();
  const image = new URL(meta(html, "og:image"));
  const first = await call(env, `${image.pathname}${image.search}`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.match(first.headers.get("cache-control"), /immutable/u);
  const png = new Uint8Array(await first.arrayBuffer());
  const picture = await decodePng(png);
  assert.equal(picture.width, 1200); assert.equal(picture.height, 630);
  const kept = [...objects.keys()].filter((key) => key.startsWith(`aniimo-cards/${RELEASE}/testpup-`));
  assert.equal(kept.length, 1);
  const again = new Uint8Array(await (await call(env, `${image.pathname}${image.search}`)).arrayBuffer());
  assert.deepEqual(again, png);
  // the Highland form's art isn't in the release: drawn with the letter, served briefly, not kept
  const highland = await call(env, "/api/aniimo-cards/testpup-highland.png");
  assert.equal(highland.status, 200);
  assert.doesNotMatch(highland.headers.get("cache-control"), /immutable/u);
  assert.equal([...objects.keys()].filter((key) => key.includes("/testpup-highland-")).length, 0);
  assert.equal((await call(env, "/api/aniimo-cards/nobody.png")).status, 404);
});

test("no release (content switched off): people still reach the Aniilog", async () => {
  const { env } = setup({ env: { CONTENT_RELEASE_ENABLED: "false" } });
  const response = await call(env, "/a/testpup");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${ORIGIN}/explorer/?view=aniilog`);
});

test("card drawing: every model shape draws; text marks the letters lack are swapped; colours are cut to the box count", async () => {
  assert.equal(cardText("Astra — Map’s “edge”…"), "Astra – Map's \"edge\"...");
  const art = await decodePng(iconPng(64));
  for (const model of [
    { name: "Testpup", form: "Basic Form", number: "#900", elements: [{ label: "Fire", color: "#e03d3d" }], role: "DPS", facts: ["1 m"], description: "Short." },
    { name: "A very long made-up Aniimo name that cannot fit", form: "", number: "", elements: [], role: "", facts: [], description: "word ".repeat(200) },
    { name: "Ünïcode Name", elements: [{ label: "Dark", color: "not a colour" }, { label: "Light", color: "#000000" }, { label: "Wind" }] },
  ]) {
    for (const withArt of [art, null]) {
      const png = await drawAniimoCard(model, LETTERS, withArt);
      const picture = await decodePng(png);
      assert.equal(picture.width, 1200);
      assert.ok(picture.palette.length <= 256);
    }
  }
  const counts = new Uint32Array(32768); counts[0] = 5; counts[32767] = 5; counts[1234] = 1;
  assert.equal(medianCut(counts, 2).length, 2);
  assert.deepEqual(medianCut(new Uint32Array(32768), 4), []);
});

test("the PNG reader: RGB, RGBA and palette pictures, every row filter; it refuses what it can't read", async () => {
  const rgb = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 9, 9, 9]);
  const read = await decodePng(pngBytes(2, 2, 2, rgb));
  assert.deepEqual([...read.rgba], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  const indexed = await decodePng(pngBytes(2, 1, 3, new Uint8Array([1, 0]), [[1, 2, 3], [4, 5, 6]]));
  assert.deepEqual(indexed.palette, [[1, 2, 3], [4, 5, 6]]); assert.deepEqual([...indexed.indices], [1, 0]);
  // every filter: a picture whose rows use filters 0-4 (made by hand), read back to the same pixels
  const width = 3; const height = 5; const c = 3;
  const pixels = Uint8Array.from({ length: width * height * c }, (_, i) => (i * 37 + 11) & 255);
  const raw = [];
  for (let y = 0; y < height; y += 1) {
    const filter = y; raw.push(filter);
    for (let x = 0; x < width * c; x += 1) {
      const at = y * width * c + x; const left = x >= c ? pixels[at - c] : 0; const up = y ? pixels[at - width * c] : 0;
      const corner = y && x >= c ? pixels[at - width * c - c] : 0;
      const p = left + up - corner; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - corner);
      const predict = [0, left, up, (left + up) >> 1, pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      raw.push((pixels[at] - predict) & 255);
    }
  }
  const plain = pngBytes(width, height, 2, pixels);
  const idat = deflateSync(Buffer.from(raw));
  const body = Buffer.concat([Buffer.from("IDAT"), idat]); const chunk = Buffer.alloc(idat.length + 12);
  chunk.writeUInt32BE(idat.length, 0); body.copy(chunk, 4); chunk.writeUInt32BE(crc32(body), idat.length + 8);
  const filtered = Buffer.concat([plain.subarray(0, 33), chunk, plain.subarray(plain.length - 12)]);
  const back = await decodePng(filtered);
  assert.deepEqual([...back.rgba].filter((_, i) => i % 4 !== 3), [...pixels]);
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3])), /Not a PNG/u);
  const big = Buffer.from(plain); big.writeUInt32BE(5000, 16); big.writeUInt32BE(5000, 20);
  await assert.rejects(decodePng(big), /too large/u);
});

test("an Aniilog entry has one row of buttons: View Model, one Hide/Show Artwork switch, Locate on Map; no Copy link", () => {
  const app = readFileSync(new URL("../public/explorer/app.js", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/explorer/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(app, /catalog-copy-link-button|copyAniimoLink|aniimoShortLink/u);
  assert.doesNotMatch(app, /showcaseButton\.addEventListener|Unhide Artwork/u);
  assert.match(app, /button\.textContent = hidden \? "Show Artwork" : "Hide Artwork";/u);
  assert.match(app, /headingActions\.append\(hideArtworkButton\);/u);
  // the narrowest phones keep the three on one row
  assert.match(css, /@media \(max-width: 400px\) \{\s+\.catalog-aniilog-record > \.catalog-identity > \.catalog-identity-actions,\s+\.catalog-mobile-sticky-aniilog\.is-stuck > \.catalog-identity-actions \{\s+grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\);/u);
  assert.doesNotMatch(css, /identity-actions > button:nth-child\(3\):last-child/u);
  // View Model: one place to switch forms, its Form menu with each form's head; the form chips are hidden there
  assert.match(css, /body\.aniilog-model-mode \.catalog-aniilog-record \.afp-forms,\s+body\.aniilog-model-mode \.catalog-mobile-sticky-aniilog \.afp-forms \{\s+display: none;/u);
  assert.match(app, /options: modelVariants\.map\(\(candidate\) => \(\{ value: candidate\.id, label: [^}]+, icon: candidate\.icon \}\)\)/u);
  assert.match(app, /const head = makeIcon\("catalog-artwork-select-icon", option\.icon\);/u);
  // a narrow menu shortens the name with "…" instead of running into its arrow
  assert.match(app, /name\.className = "catalog-artwork-select-label";/u);
  assert.match(css, /\.catalog-artwork-select-label \{\s+min-width: 0;\s+overflow: hidden;\s+text-overflow: ellipsis;/u);
  const html = readFileSync(new URL("../public/explorer/index.html", import.meta.url), "utf8");
  assert.match(html, /aniimo-link\.js\?v=0\.1\.2/u);
});
