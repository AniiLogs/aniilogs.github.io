import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { addCard, bumpTag, guideFolders, listedIds, pageFacts, releasePin } from "../scripts/sarg-guides.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../public/guides/linked-guides.js");

test("the ids already on the Guides page are found", () => {
  const ids = listedIds(source);
  assert.ok(ids.has("night-parade") && ids.has("friendship"));
  assert.equal(ids.has("sargeeva"), false);
});

test("only guide folders count: not assets, files or odd names", () => {
  const entries = [
    { type: "dir", name: "assets" },
    { type: "dir", name: "resonance-fantasia" },
    { type: "dir", name: ".github" },
    { type: "file", name: "index.html" },
    { type: "dir", name: "badges" },
  ];
  assert.deepEqual(guideFolders(entries), ["badges", "resonance-fantasia"]);
});

test("a page's title and description are read, a trailing Guide dropped", () => {
  const html = `<head><title>Resonance Fantasia Guide</title>
    <meta name="description" content="Aniimo&#39;s event: dates &amp; rewards."></head>`;
  assert.deepEqual(pageFacts(html), { title: "Resonance Fantasia", description: "Aniimo's event: dates & rewards." });
  assert.deepEqual(pageFacts("<title>Egg Heist Loot Tables</title>"), { title: "Egg Heist Loot Tables", description: "" });
});

test("a drafted card joins the list and the list still loads", () => {
  const next = addCard(source, { id: "new-one", title: "New \"One\"", summary: "Something new." });
  const window = {};
  vm.runInNewContext(next, { window });
  const { guides } = window.AniilogsLinkedGuides;
  const added = guides.at(-1);
  assert.equal(guides.length, listedIds(source).size + 1);
  assert.deepEqual({ ...added }, {
    by: "sargeeva",
    host: "sargeeva.github.io",
    id: "new-one",
    title: "New \"One\"",
    url: "https://sargeeva.github.io/aniimo-guides/new-one/",
    summary: "Something new.",
  });
  assert.ok(listedIds(next).has("new-one"));
});

test("the page's linked-guides.js tag moves to the next patch version", () => {
  const html = '<script src="/guides/linked-guides.js?v=0.1.9" defer></script>';
  assert.equal(bumpTag(html), '<script src="/guides/linked-guides.js?v=0.1.10" defer></script>');
  assert.throws(() => bumpTag("<p>no script</p>"));
});

// A Windows checkout writes public/_headers (no extension, so not counted as text) with CRLF; the pin is made on Linux.
const crlfHeaders = (await read("../public/_headers")).includes("\r");

test("the release pin is worked out the way the release check reads it", { skip: crlfHeaders && "public/_headers has Windows line endings here" }, async () => {
  const pin = JSON.parse(await read("../release-review.json"));
  assert.deepEqual(releasePin(), {
    publicFileCount: pin.publicFileCount,
    publicTotalBytes: pin.publicTotalBytes,
    publicTreeSha256: pin.publicTreeSha256,
  });
});
