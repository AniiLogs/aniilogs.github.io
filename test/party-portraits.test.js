// The run viewer reads each player's lead Aniimo from the run's Party picture (public/party-portraits.js). No picture
// of the game is in the repository, so these draw their own: made-up "portraits" with a soft edge, placed on a made-up
// Party screen where the game puts them.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../public/party-portraits.js", import.meta.url), "utf8");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(source, context);
const { core } = context.window.AniilogsPartyPortraits;
// values made inside the script's own context compare by content, not by its Array and Object
const plain = (value) => JSON.parse(JSON.stringify(value));

// a repeatable noise source, so every run draws the same pictures
function random(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// A made-up portrait: blocks of colour inside a round shape with a soft edge, on nothing.
function portrait(seed, size) {
  const next = random(seed);
  const blocks = 6;
  const colours = Array.from({ length: blocks * blocks }, () => [next() * 255, next() * 255, next() * 255]);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const colour = colours[Math.floor(y * blocks / size) * blocks + Math.floor(x * blocks / size)];
      const d = Math.hypot(x - size / 2, y - size / 2) / (size / 2);
      out.set([colour[0], colour[1], colour[2], Math.max(0, Math.min(255, (0.95 - d) * 255 * 8))], (y * size + x) * 4);
    }
  }
  return out;
}
const SIZE = 64;
const NAMES = ["Alder", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hazel", "Ivy", "Juniper", "Kapok", "Larch"];
const pack = { size: SIZE, names: NAMES, tiles: NAMES.map((_, index) => portrait(100 + index, SIZE)), fade: new Uint8Array(SIZE * SIZE).fill(255) };

// A made-up Party screen, width x height: a busy background, each card's skill badges, and the leads' portraits
// (pack tile numbers, one per card; null leaves a card without one), everything on a card moved by `nudge` px.
function partyScreen(width, height, leads, nudge = [0, 0]) {
  const next = random(7);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([40 + next() * 60, 50 + next() * 60, 80 + next() * 60, 255], i * 4);
  const u = Math.min(width, height * 16 / 9);
  const ux = (width - u) / 2;
  const unit = 0.0503 * u / 240;
  core.LAYOUTS.interlink.forEach(([a, b], card) => {
    const cy = height * (b + 0.0472) + u * 0.0405 / 2 + nudge[1];
    for (let tile = 0; tile < 3; tile += 1) {                        // the badges: a dark round with a light rim
      const cx = ux + u * (a + 0.0503 * tile - 0.0345 + 0.0405 / 2) + 74 * unit + nudge[0];
      const r = 42 * unit;
      for (let y = Math.floor(cy - r * 1.2); y <= cy + r * 1.2; y += 1) {
        for (let x = Math.floor(cx - r * 1.2); x <= cx + r * 1.2; x += 1) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= r * 1.07 && d > r * 0.7) data.set(d <= r * 0.97 ? [60, 60, 75, 255] : [220, 220, 220, 255], (y * width + x) * 4);
        }
      }
    }
    if (leads[card] === null || leads[card] === undefined) return;
    const side = Math.round(256 * unit);
    const px = ux + u * (a - 0.0345 + 0.0405 / 2) - 6 * unit + nudge[0];
    const py = cy - 152 * unit;
    const art = portrait(100 + leads[card], side);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const at = (Math.round(py - side / 2) + y) * width + Math.round(px - side / 2) + x;
        const alpha = art[(y * side + x) * 4 + 3] / 255;
        for (let c = 0; c < 3; c += 1) data[at * 4 + c] = art[(y * side + x) * 4 + c] * alpha + data[at * 4 + c] * (1 - alpha);
      }
    }
  });
  return { width, height, data };
}

test("each card's lead is read from its portrait, at the sizes proofs are stored in", () => {
  for (const [width, height] of [[1920, 1080], [2560, 1440]]) {
    const found = core.leads(partyScreen(width, height, [3, 7, 0, 11]), pack, "interlink");
    assert.deepEqual(plain(found.map((item) => item.name)), ["Dogwood", "Hazel", "Alder", "Larch"], `${width} wide`);
    assert.ok(found.every((item) => item.sure), JSON.stringify(found));
  }
});

test("a card drawn higher or lower is still found by its skill badges", () => {
  const found = core.leads(partyScreen(1920, 1080, [5, 2, 9, 4], [3, 14]), pack, "interlink");
  assert.deepEqual(plain(found.map((item) => [item.name, item.sure])), [["Fir", true], ["Cedar", true], ["Juniper", true], ["Elm", true]]);
});

test("a card with no portrait gives no answer that counts", () => {
  const found = core.leads(partyScreen(1920, 1080, [1, null, null, null]), pack, "interlink");
  assert.equal(found[0].name, "Birch");
  assert.ok(found[0].sure);
  assert.ok(found.slice(1).every((item) => !item.sure), JSON.stringify(found));
});

test("the picture decides the lead; the name the app sent only confirms it", () => {
  const species = ["Jeburst", "Hypnyto", "Dewple", "Piopiota", "Turbo", "Somniwing", "Sugartini"];
  const read = (names) => names.map((name, card) => ({ card, name, sure: Boolean(name) }));
  const copy = { aniimo: "Dewple", aniimoLevel: 70, cp: 3686, team: [{ aniimo: "Dewple" }, { aniimo: "Piopiota" }, { aniimo: "Turbo" }] };
  const lineup = [
    { name: "A", ...copy },                                                                  // slot 0: the API leaves it out
    { slot: 1, name: "B", aniimo: "Tiamat", aniimoLevel: 70, cp: 4088, team: [{ aniimo: "Tiamat" }, { aniimo: "Piopiota" }] },
    { slot: 2, name: "C", aniimo: "Hypnyto", cp: 3561, team: [{ aniimo: "Hypnyto" }] },
    { slot: 3, name: "D", ...copy },
  ];
  const out = core.applyLeads(lineup, read(["Hypnyto", "Jeburst", "Hypnyto", "Dewple"]), species);
  // a name that is no Aniimo is the player's nickname: the species comes from the picture, the card's facts stay
  assert.deepEqual(plain(out[1]), { slot: 1, name: "B", aniimo: "Jeburst", aniimoLevel: 70, cp: 4088,
    team: [{ aniimo: "Jeburst", nickname: "Tiamat" }, { aniimo: "Piopiota" }], nickname: "Tiamat" });
  // the same Aniimo: confirmed, untouched
  assert.equal(out[2], lineup[2]);
  assert.equal(out[3], lineup[3]);
  // another Aniimo on a card that is word for word another player's: the picture's lead, without that card's facts
  assert.deepEqual(plain(out[0]), { name: "A", aniimo: "Hypnyto" });
});

test("a lead the picture doesn't show clearly, and an AI teammate, stay as they were", () => {
  const lineup = [{ name: "A", aniimo: "Tiamat" }, { slot: 1, name: "B", aniimo: "Nickname", ai: true }];
  const found = [{ card: 0, name: "Jeburst", sure: false }, { card: 1, name: "Dewple", sure: true }];
  assert.deepEqual(plain(core.applyLeads(lineup, found, ["Jeburst", "Dewple"])), lineup);
  // another Aniimo with facts of its own keeps them
  const own = [{ name: "A", aniimo: "Dewple", cp: 3000, team: [{ aniimo: "Dewple" }, { aniimo: "Turbo" }] }];
  assert.deepEqual(plain(core.applyLeads(own, [{ card: 0, name: "Jeburst", sure: true }], ["Jeburst", "Dewple", "Turbo"])),
    [{ name: "A", aniimo: "Jeburst", cp: 3000, team: [{ aniimo: "Jeburst" }, { aniimo: "Turbo" }] }]);
});
