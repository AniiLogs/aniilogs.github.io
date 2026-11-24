// Browsers may keep a tagged script or stylesheet (?v=...) for a long time, so a changed file needs a new tag and
// every page must load a file with the same tag (scripts/asset-versions.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { currentAssets, problems } from "../scripts/asset-versions.mjs";

test("every tagged script and stylesheet: one tag on every page, a new tag whenever it changes", () => {
  const found = problems();
  assert.deepEqual(found, [], `${found.join("\n")}\n(after giving a changed file a new tag: node scripts/asset-versions.mjs --write)`);
});

test("the tag check catches a file changed under its old tag, two tags for one file, and a missing file", () => {
  const current = new Map([
    ["a.js", { tags: ["1"], pages: ["index.html"], sha256: "new" }],
    ["b.css", { tags: ["1", "2"], pages: ["index.html", "x.html"], sha256: "same" }],
    ["c.js", { tags: ["2"], pages: ["index.html"], sha256: null }],
  ]);
  const recorded = { "a.js": { tag: "1", sha256: "old" }, "b.css": { tag: "1", sha256: "same" }, "c.js": { tag: "2", sha256: null } };
  const found = problems(current, recorded).join("\n");
  assert.match(found, /a\.js: changed but still tagged \?v=1/u);
  assert.match(found, /b\.css: loaded with different tags \(1, 2\)/u);
  assert.match(found, /c\.js: the pages load a file that isn't there/u);
  assert.ok(currentAssets().has("explorer/app.js"));
});
