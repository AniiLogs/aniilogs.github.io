import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const picker = await readFile(new URL("../public/explorer/aniimo-picker.js", import.meta.url), "utf8");
const duel = await readFile(new URL("../public/explorer/duel.js", import.meta.url), "utf8");

test("the Aniimo picker filters on every typed word and keeps the select as the source of truth", () => {
  assert.match(picker, /words\.every\(\(word\) => matches\(entry, word\)\)/u);
  // Anywhere in the text, "#45" as the number 45, matches highlighted, and a clear button.
  assert.match(picker, /entry\.haystack\.includes\(word\.replace\(\/\^#\/u, ""\)\)/u);
  assert.match(picker, /entry\.numbers\.has\(String\(Number\(word\.slice\(1\)\)\)\)/u);
  assert.match(picker, /item\.append\(\.\.\.highlighted\(entry\.option\.textContent, words\)\)/u);
  assert.match(picker, /aniimo-picker-clear/u);
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

test("the open list moves to <body> so a contained panel can't offset or clip it", () => {
  assert.match(picker, /document\.body\.append\(list\)/u);
  assert.match(picker, /if \(list\.parentNode !== wrap\) wrap\.insertBefore\(list, select\)/u);
});

test("every dropdown on the Team Builder, 1v1 and potential editor gets the type-to-filter picker", async () => {
  for (const name of ["team-builder.js", "duel.js", "potential-editor.js"]) {
    const source = await readFile(new URL(`../public/explorer/${name}`, import.meta.url), "utf8");
    const selects = (source.match(/el\("select"/gu) || []).length;
    const enhanced = (source.match(/AniilogsPicker\?\.enhance\(/gu) || []).length;
    assert.equal(enhanced, selects, `${name}: ${selects} selects, ${enhanced} enhanced`);
  }
});
