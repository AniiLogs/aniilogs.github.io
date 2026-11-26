import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const source = await read("../public/guides/linked-guides.js");
const guidesHtml = await read("../public/guides/index.html");
const guidesJs = await read("../public/guides/guides.js");

function load() {
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AniilogsLinkedGuides;
}

const EVENT_END = "2026-12-09T23:59:59Z";
// Resonance Fantasia ends latest on the Americas server (game_event_data 10000098)
const FANTASIA_END = "2026-12-17T07:59:59Z";

test("the Guides page links each of sargeeva's guides directly", () => {
  const { guides } = load();
  assert.ok(guides.length >= 8);
  assert.equal(new Set(guides.map((guide) => guide.id)).size, guides.length);
  for (const guide of guides) {
    assert.ok(guide.url.startsWith("https://sargeeva.github.io/aniimo-guides/"), guide.url);
    assert.ok(guide.url.endsWith("/"), guide.url);
    assert.notEqual(guide.url, "https://sargeeva.github.io/aniimo-guides/");
    assert.ok(guide.title && guide.summary, guide.id);
    assert.equal(guide.by, "sargeeva");
    assert.equal(guide.host, "sargeeva.github.io");
  }
  for (const guide of guides.filter((entry) => entry.ends)) {
    assert.match(guide.ends, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/u, guide.id);
  }
  for (const id of ["night-parade", "nighttime-gathering"]) {
    assert.equal(guides.find((guide) => guide.id === id).ends, EVENT_END);
  }
});

test("an event guide is archived only after its end; a guide without an end never is", () => {
  const { guides, isArchived } = load();
  const end = Date.parse(EVENT_END);
  const event = guides.find((guide) => guide.id === "night-parade");
  assert.equal(isArchived(event, end), false);
  assert.equal(isArchived(event, end + 1000), true);
  const lasting = guides.find((guide) => !guide.ends);
  for (const now of [0, end, end + 1000, Date.parse("2100-01-01T00:00:00Z")]) assert.equal(isArchived(lasting, now), false);
});

test("the page loads the linked guides first and opens them in a new tab, archiving ended ones", () => {
  const linked = guidesHtml.indexOf('<script src="/guides/linked-guides.js?v=');
  const list = guidesHtml.indexOf('<script src="/guides/guides.js?v=');
  assert.ok(linked > 0 && list > linked);
  assert.match(guidesJs, /card\.target = "_blank";/u);
  assert.match(guidesJs, /card\.rel = "noopener";/u);
  assert.match(guidesJs, /linked\.isArchived\(guide, now\)/u);
});
