import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const explorerHtml = await readFile(new URL("../public/explorer/index.html", import.meta.url), "utf8");
const explorerStyles = await readFile(new URL("../public/explorer/styles.css", import.meta.url), "utf8");
const landingApp = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const landingHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const landingStyles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const localContentServer = await readFile(new URL("../scripts/serve-private-content.mjs", import.meta.url), "utf8");

test("procedural and withheld maps stay out of the public map navigator", () => {
  assert.match(explorer, /HIDDEN_MAP_IDS = new Set\(\["egg-heist", "egg-heist-team"\]\)/u);
  assert.match(explorer, /!String\(map\.id \|\| ""\)\.startsWith\("procedural-"\)/u);
  assert.match(explorer, /map\.visibility !== "withheld"/u);
  assert.match(explorer, /filter\(\(map\) => !map\.parent_map_id && !map\.layer\)/u);
  assert.match(explorerHtml, /Withheld until current-build numbering is verified/u);
  assert.doesNotMatch(explorer, /current atlas views/u);
});

test("only proven entrance pins are prepared for future interior and vertical-layer navigation", () => {
  assert.match(explorerHtml, /id="mapSectionShortcutLayer"/u);
  assert.match(explorerHtml, /id="mapOverlayBackButton"/u);
  assert.match(explorer, /function openMapOverlay\(mapId\)/u);
  assert.match(explorer, /map\?\.parent_map_id/u);
  assert.match(explorer, /switchMap\(parentMapId\)/u);
  assert.match(explorerStyles, /\.map-surface\.has-map-overlay \.map-viewport/u);
  assert.match(explorer, /map transitions are exposed only through proven entrance markers/u);
  assert.doesNotMatch(explorer, /shortcut\.textContent = section\.kind/u);
  assert.match(explorer, /spawn\.hover_icon \|\| item\.hover_icon/u);
  assert.match(explorerStyles, /\.pin:hover \.pin-icon-selected/u);
  assert.match(explorerStyles, /\.pin\.pin-underground \{[\s\S]*--pin-size: 22px/u);
});

test("dark mode is the default and can be switched site-wide", () => {
  assert.match(landingHtml, /data-theme-toggle/u);
  assert.match(landingApp, /aniilogs:color-mode:v1/u);
  assert.match(landingApp, /const normalized = mode === "light" \? "light" : "dark"/u);
  assert.match(landingApp, /getItem\(COLOR_MODE_STORAGE_KEY\) \|\| "dark"/u);
  assert.match(landingStyles, /:root\[data-color-mode="light"\]/u);
  assert.match(explorer, /label: "AniiLogs Night"/u);
});

test("the shared shell keeps primary navigation visible and transitions fluidly", () => {
  assert.match(explorerHtml, /class="app-topbar"/u);
  assert.match(explorerHtml, /id="topNavMap"/u);
  assert.match(explorerHtml, /id="topNavItemlog"/u);
  assert.match(explorerStyles, /view-transition-name: aniilogs-topbar/u);
  assert.match(explorerStyles, /@view-transition\s*\{\s*navigation: auto/u);
  assert.match(landingStyles, /view-transition-name: aniilogs-topbar/u);
  assert.match(landingStyles, /\.site-header nav\s*\{[^}]*display: flex/u);
  assert.doesNotMatch(landingStyles, /@media \(max-width: 720px\)[\s\S]*?\bnav\s*\{\s*display: none/u);
});

test("light and dark themes avoid whole-control opacity and dark-only text colors", () => {
  assert.match(landingStyles, /:root\[data-color-mode="light"\] \.site-header/u);
  assert.match(landingStyles, /:root:not\(\[data-color-mode="light"\]\) \.primary-button/u);
  assert.doesNotMatch(explorerStyles, /\.workspace-tab:disabled\s*\{[^}]*opacity:/u);
  assert.doesNotMatch(
    explorerStyles,
    /\.item-row:not\(\.enabled\):not\(\.partially-enabled\)\s*\{\s*opacity:\s*0\.45/u,
  );
  assert.match(explorerStyles, /\.checklist-category-tab\s*\{[\s\S]*?rgba\(var\(--background-rgb\), 0\.82\)/u);
  assert.match(explorerStyles, /\.catalog-description\s*\{[\s\S]*?color-mix\(in srgb, var\(--muted\)/u);
  assert.match(explorerStyles, /\.catalog-index-row--tiered \.catalog-index-copy small\s*\{[\s\S]*?var\(--text\)/u);
});

test("the local private-content bridge is scoped and contains no machine-specific path", () => {
  assert.match(localContentServer, /http:\/\/127\.0\.0\.1:8787/u);
  assert.match(localContentServer, /access-control-allow-origin/u);
  assert.match(localContentServer, /no-store/u);
  assert.doesNotMatch(localContentServer, /[A-Z]:\\Users\\/u);
});
