import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// The picked theme (theme-shell.js, from localStorage) must be on <html> before the first paint, or every page shows
// the default theme for a moment: theme-shell.js loads without defer, in <head>, before any stylesheet.
const publicRoot = new URL("../public/", import.meta.url);

async function pages(dir = publicRoot) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) out.push(...await pages(url));
    else if (entry.name.endsWith(".html") && !/^google[0-9a-f]+\.html$/u.test(entry.name)) out.push(url);
  }
  return out;
}

test("every page loads theme-shell.js blocking, in <head>, before its stylesheets", async () => {
  const list = await pages();
  assert.ok(list.length >= 10);
  for (const url of list) {
    const html = await readFile(url, "utf8");
    const tags = [...html.matchAll(/<script[^>]*theme-shell\.js[^>]*><\/script>/gu)].map((match) => match[0]);
    assert.equal(tags.length, 1, `${url.pathname}: one theme-shell.js`);
    assert.doesNotMatch(tags[0], /\b(?:defer|async|type="module")\b/u, url.pathname);
    const at = html.indexOf(tags[0]);
    assert.ok(at < html.indexOf("</head>"), `${url.pathname}: in <head>`);
    const firstStylesheet = html.indexOf('rel="stylesheet"');
    assert.ok(firstStylesheet < 0 || at < firstStylesheet, `${url.pathname}: before the stylesheets`);
    assert.ok(at > html.indexOf('<meta name="theme-color"'), `${url.pathname}: after the theme-color meta it updates`);
  }
});

test("theme-shell.js applies the saved theme as it runs, before the page's body exists", async () => {
  const source = await readFile(new URL("theme-shell.js", publicRoot), "utf8");
  const properties = new Map();
  const root = { dataset: {}, style: { setProperty: (name, value) => properties.set(name, value) } };
  const listeners = [];
  const document = {
    readyState: "loading", documentElement: root, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (type) => listeners.push(type),
  };
  const storage = new Map([["aniilogs:explorer:preferences:v1", JSON.stringify({ theme: "pawney" })]]);
  const window = {
    location: { search: "", href: "https://aniilogs.app/leaderboard/", protocol: "https:" },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {}, dispatchEvent() {},
  };
  vm.runInNewContext(source, { window, document, URLSearchParams, CustomEvent: class {}, Option: class {} });
  assert.equal(root.dataset.theme, "pawney");
  assert.equal(properties.get("--background"), "#0e1120");
  assert.ok(listeners.includes("DOMContentLoaded"), "controls are bound once the page is parsed");

  // nothing saved (or storage blocked): the default theme, no error
  const blank = { dataset: {}, style: { setProperty() {} } };
  vm.runInNewContext(source, {
    window: { ...window, localStorage: { getItem: () => { throw new Error("blocked"); } } },
    document: { ...document, documentElement: blank }, URLSearchParams, CustomEvent: class {}, Option: class {},
  });
  assert.equal(blank.dataset.theme, "default");
});
