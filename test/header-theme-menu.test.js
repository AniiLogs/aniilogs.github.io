import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The Theme picker moved out of the header bar (it crowded the bar on phones) into the header's menus.
const read = async (path) => (await readFile(new URL(`../public/${path}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const STATIC = ["index.html", "companion/index.html", "guides/index.html", "leaderboard/index.html",
  "updates/3934365/index.html", "updates/3973445/index.html", "updates/3989635/index.html"];
const between = (html, start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

test("the bar holds no Theme picker; the account menu has it first", async () => {
  for (const page of [...STATIC, "explorer/index.html"]) {
    const html = await read(page);
    assert.doesNotMatch(html, /theme-picker-label|theme-picker-copy/u, page);
    const account = between(html, '<div class="account-menu-popover">\n', "</details>");
    assert.ok(html.includes("data-account-menu"), page);
    const popovers = [...html.matchAll(/<div class="account-menu-popover">\n\s*<label class="menu-theme-picker">\n\s*<span>Theme<\/span>\n\s*<select class="theme-picker" data-site-theme-select aria-label="Website theme">/gu)];
    assert.ok(popovers.length >= 1, `${page}: Theme first in a menu`);
    assert.ok(account.length > 0, page);
  }
});

test("signed out, the gear opens a menu with Theme and All settings (it hides once signed in, like the old link)", async () => {
  for (const page of STATIC) {
    const html = await read(page);
    const menu = between(html, '<details class="account-menu site-menu" data-site-menu data-settings-shortcut>', "</details>");
    assert.ok(menu, `${page}: the gear's menu`);
    assert.match(menu, /<summary class="settings-gear-button" aria-label="Settings and theme" title="Settings">/u, page);
    assert.match(menu, /data-site-theme-select/u, page);
    assert.match(menu, /<a href="\/explorer\/\?settings=1">All settings<\/a>/u, page);
    assert.equal((html.match(/data-settings-shortcut/gu) || []).length, 1, `${page}: one settings shortcut`);
    assert.equal((html.match(/data-site-theme-select/gu) || []).length, 2, `${page}: the gear's menu and the account menu`);
  }
  const themeShell = await read("theme-shell.js");
  assert.match(themeShell, /querySelectorAll\("\[data-account-menu\], \[data-site-menu\]"\)/u, "hover, Escape and focus as the account menu");
  assert.match(themeShell, /document\.querySelectorAll\("\[data-site-theme-select\]"\)\.forEach\(\(select\) => \{\n\s*select\.addEventListener\("change"/u);
  const chrome = await read("site-chrome.js");
  assert.match(chrome, /settings\.hidden = signedIn;/u);
  const css = await read("site-chrome.css");
  assert.match(css, /html\[data-embed="app"\] \.menu-theme-picker \{ display: none !important; \}/u);
  assert.match(css, /html\[data-embed="app"\] \.app-topbar \.account-menu\.site-menu:not\(\[hidden\]\) \{ display: block !important; \}/u);
});
