import assert from "node:assert/strict";
import test from "node:test";

import { parseCookies, safeReturnTo } from "../src/index.js";

test("safeReturnTo accepts same-origin paths", () => {
  assert.equal(safeReturnTo("/map?zone=idyll#markers"), "/map?zone=idyll#markers");
});
test("safeReturnTo rejects external and protocol-relative redirects", () => {
  assert.equal(safeReturnTo("https://example.com"), "/");
  assert.equal(safeReturnTo("//example.com/path"), "/");
  assert.equal(safeReturnTo("\\example.com"), "/");
});

test("parseCookies preserves values containing equals signs", () => {
  assert.deepEqual(parseCookies("a=one; session=abc==; theme=dark"), {
    a: "one",
    session: "abc==",
    theme: "dark",
  });
});
