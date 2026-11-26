// Limited-time event pins (Resonance Fantasia, Vein Abundance...) carry event_ends_at in the map data and leave the
// map by themselves once it has passed, so an ended event needs no data change. The pins here are made up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../public/explorer/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in app.js`);
  const end = app.indexOf("\n}\n", start);
  return app.slice(start, end + 3);
}

const context = {};
vm.runInNewContext(`${functionSource("mapEventHasEnded")}\n${functionSource("withoutEndedMapEvents")}\n`
  + "this.mapEventHasEnded = mapEventHasEnded; this.withoutEndedMapEvents = withoutEndedMapEvents;", context);
const { mapEventHasEnded, withoutEndedMapEvents } = context;

const ENDS = "2026-12-17T07:59:59Z";
const before = Date.parse("2026-12-17T07:59:58Z");
const after = Date.parse("2026-12-17T08:00:00Z");

test("an event pin shows until its end and is gone from then on", () => {
  const pin = { item_id: "aniimo:10713:form:basic", coordinate_key: "ENTITY_3000_1", event_ends_at: ENDS };
  assert.equal(mapEventHasEnded(pin, before), false);
  assert.equal(mapEventHasEnded(pin, Date.parse(ENDS)), true);
  assert.equal(mapEventHasEnded(pin, after), true);
});

test("pins without an end time, or with an unreadable one, always show", () => {
  for (const pin of [{}, { event_ends_at: "" }, { event_ends_at: "soon" }, { event_ends_at: 1797494399 }, null]) {
    assert.equal(mapEventHasEnded(pin, after), false);
  }
});

test("filtering keeps the other pins and their order, and drops only the ended event pins", () => {
  const pins = [
    { coordinate_key: "A" },
    { coordinate_key: "B", event_ends_at: "2026-12-07T07:59:59Z" },
    { coordinate_key: "C", event_ends_at: ENDS },
    { coordinate_key: "D" },
  ];
  assert.deepEqual(withoutEndedMapEvents(pins, before).map((pin) => pin.coordinate_key), ["A", "C", "D"]);
  assert.deepEqual(withoutEndedMapEvents(pins, after).map((pin) => pin.coordinate_key), ["A", "D"]);
  assert.equal(pins.length, 4);                                     // the loaded data itself is left as it is
});

test("the map applies it to the items and pins of every map it shows, with one clock", () => {
  assert.match(app, /function useMapDatasetNow\(mapId, dataset\) \{\n  if \(!state\.bootstrap \|\| state\.activeMapId !== mapId\) return;\n  const now = Date\.now\(\);/u);
  assert.match(app, /items: withoutEndedMapEvents\(dataset\?\.items \|\| \[\], now\),/u);
  assert.match(app, /spawns: withUnreleasedMapRecords\(withoutEndedMapEvents\(dataset\?\.spawns \|\| \[\], now\)\),/u);
});
