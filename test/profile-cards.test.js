import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// the page's script, run as the browser runs it
const window = {};
vm.runInNewContext(readFileSync(new URL("../public/profile-cards.js", import.meta.url), "utf8"), { window });
// its arrays and objects come from another realm: compared as plain data
const plain = (value) => JSON.parse(JSON.stringify(value));
const cards = window.AniiProfileCards;
const arrangeCards = (...args) => plain(cards.arrangeCards(...args));
const layoutOf = (...args) => plain(cards.layoutOf(...args));
const moveCard = (...args) => plain(cards.moveCard(...args));
const CARDS = ["interlink", "sim", "eggheist", "collection", "photos"].map((id) => ({ id, title: id }));
const ids = (list) => list.map((card) => `${card.id}${card.hidden ? " (hidden)" : ""}`);

test("no saved layout: the page's order, everything shown", () => {
  assert.deepEqual(ids(arrangeCards(CARDS, null)), ["interlink", "sim", "eggheist", "collection", "photos"]);
  assert.deepEqual(layoutOf(arrangeCards(CARDS, null), CARDS), { order: [], hidden: [] });
});

test("the owner's order and hidden cards; unknown saved ids are skipped", () => {
  const list = arrangeCards(CARDS, { order: ["photos", "gone-card", "sim"], hidden: ["eggheist"] });
  assert.deepEqual(ids(list), ["photos", "sim", "interlink", "eggheist (hidden)", "collection"]);
  assert.deepEqual(layoutOf(list, CARDS), { order: ["photos", "sim", "interlink", "eggheist", "collection"], hidden: ["eggheist"] });
});

test("a card the site adds later goes last and shows, without touching the saved layout", () => {
  const saved = { order: ["sim", "interlink", "eggheist", "collection", "photos"], hidden: ["photos"] };
  const withNew = [...CARDS, { id: "fake-new-card", title: "Fake new card" }];
  assert.deepEqual(ids(arrangeCards(withNew, saved)), ["sim", "interlink", "eggheist", "collection", "photos (hidden)", "fake-new-card"]);
  // once arranged, it's part of the order like any other
  const moved = moveCard(arrangeCards(withNew, saved), "fake-new-card", { to: 0 });
  assert.deepEqual(layoutOf(moved, withNew).order, ["fake-new-card", "sim", "interlink", "eggheist", "collection", "photos"]);
});

test("moving: up and down stop at the ends; drag drops at an index", () => {
  const list = arrangeCards(CARDS, null);
  assert.deepEqual(ids(moveCard(list, "sim", { step: -1 })), ["sim", "interlink", "eggheist", "collection", "photos"]);
  assert.deepEqual(ids(moveCard(list, "interlink", { step: -1 })), ids(list));
  assert.deepEqual(ids(moveCard(list, "photos", { step: 1 })), ids(list));
  assert.deepEqual(ids(moveCard(list, "interlink", { to: 3 })), ["sim", "eggheist", "collection", "interlink", "photos"]);
  assert.deepEqual(ids(moveCard(list, "nope", { step: 1 })), ids(list));
});
