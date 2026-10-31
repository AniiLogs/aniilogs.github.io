import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const picker = await readFile(new URL("../public/explorer/aniimo-picker.js", import.meta.url), "utf8");
const duel = await readFile(new URL("../public/explorer/duel.js", import.meta.url), "utf8");

test("the Aniimo picker filters on every typed word and keeps the select as the source of truth", () => {
  assert.match(picker, /words\.every\(\(word\) => entry\.haystack\.includes\(word\)\)/u);
  assert.match(picker, /select\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/u);
  assert.match(picker, /role", "combobox"/u);
  assert.match(picker, /"ArrowDown" \|\| event\.key === "ArrowUp"/u);
  assert.match(picker, /event\.key === "Enter"/u);
  assert.match(picker, /event\.key === "Escape"/u);
  assert.match(picker, /option\.dataset\.search/u);
});

test("both 1v1 sides use the picker, with elements and the Aniilog number as search words", () => {
  assert.match(duel, /window\.AniilogsPicker\?\.enhance\(select/u);
  assert.match(duel, /option\.dataset\.search = \[\.\.\.\(entry\.elements \|\| \[\]\)\.map\(\(item\) => item\.name\), entry\.aniilog_number\]/u);
});
