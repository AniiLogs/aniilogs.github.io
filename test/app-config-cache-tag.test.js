import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Browsers cache app-config.js by its URL, so every page must load it under the current
// contentRevision. Otherwise a content release keeps showing the previous revision until
// the cached script expires.
const explorerConfig = await readFile(new URL("../public/explorer/app-config.js", import.meta.url), "utf8");
const pages = ["../public/explorer/index.html", "../public/index.html", "../public/privacy.html"];

test("every page loads app-config.js under the current contentRevision", async () => {
  const revision = /const contentRevision = "([^"]+)"/u.exec(explorerConfig)?.[1];
  assert.ok(revision, "app-config.js must define contentRevision");
  for (const page of pages) {
    const html = await readFile(new URL(page, import.meta.url), "utf8");
    const tags = [...html.matchAll(/app-config\.js\?v=([^"]+)"/gu)].map((match) => match[1]);
    assert.ok(tags.length, `${page} must load app-config.js with a ?v= tag`);
    for (const tag of tags) {
      assert.equal(tag, revision, `${page} loads app-config.js?v=${tag}; set it to the contentRevision "${revision}"`);
    }
  }
});
