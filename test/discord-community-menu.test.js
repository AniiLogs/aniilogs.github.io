import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

for (const path of ["public/index.html", "public/explorer/index.html"]) {
  test(`${path} offers the community invite in the Discord account menu`, async () => {
    const html = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    const menu = html.match(/<details\b[^>]*\bdata-account-menu\b[^>]*>([\s\S]*?)<\/details>/u)?.[1];
    assert.ok(menu, "Existing account menu must be present");
    const links = [...menu.matchAll(/<a\b([^>]*)>Join the Discord<\/a>/gu)];
    assert.equal(links.length, 1);
    assert.match(links[0][1], /href="https:\/\/discord\.gg\/uMMbabh6k2"/u);
    assert.match(links[0][1], /target="_blank"/u);
    assert.match(links[0][1], /rel="noopener noreferrer"/u);
    assert.doesNotMatch(links[0][1], /\b(?:hidden|data-login|aria-disabled)\b/u);
  });
}
