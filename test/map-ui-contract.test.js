import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorer = await readFile(new URL("../public/explorer/app.js", import.meta.url), "utf8");
const explorerHtml = await readFile(new URL("../public/explorer/index.html", import.meta.url), "utf8");
const explorerStyles = await readFile(new URL("../public/explorer/styles.css", import.meta.url), "utf8");
const landingApp = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const landingHtml = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const landingStyles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
const themeShell = await readFile(new URL("../public/theme-shell.js", import.meta.url), "utf8");
const localContentServer = await readFile(new URL("../scripts/serve-private-content.mjs", import.meta.url), "utf8");

test("procedural and withheld maps stay out of the public map navigator", () => {
  assert.match(explorer, /HIDDEN_MAP_IDS = new Set\(\["egg-heist", "egg-heist-team"\]\)/u);
  assert.match(explorer, /!String\(map\.id \|\| ""\)\.startsWith\("procedural-"\)/u);
  assert.match(explorer, /map\.visibility !== "withheld"/u);
  assert.match(explorer, /filter\(\(map\) => !map\.parent_map_id && !map\.layer\)/u);
  assert.match(explorerHtml, /Withheld until current-build numbering is verified/u);
  assert.doesNotMatch(explorer, /current atlas views/u);
});

test("current section overlays and cave entrances expose interior navigation", () => {
  assert.match(explorerHtml, /id="mapSectionShortcutLayer"/u);
  assert.match(explorerHtml, /id="mapOverlayBackButton"/u);
  assert.match(explorer, /function openMapOverlay\(mapId\)/u);
  assert.match(explorer, /map\?\.parent_map_id/u);
  assert.match(explorer, /switchMap\(parentMapId\)/u);
  assert.match(explorerStyles, /\.map-surface\.has-map-overlay \.map-viewport/u);
  assert.match(explorer, /Array\.isArray\(map\?\.map_sections\)/u);
  assert.match(explorer, /link\.style\.clipPath = `polygon/u);
  assert.match(explorer, /label\.textContent = section\.label/u);
  assert.match(explorer, /map\.parent_map_id === activeParentId/u);
  assert.match(explorer, /areas\.label = `\$\{parent\.label\} areas \(\$\{childMaps\.length\}\)`/u);
  assert.match(explorer, /closest\("\.map-section-link"\)\) return;/u);
  assert.match(explorer, /spawn\.hover_icon \|\| item\.hover_icon/u);
  assert.match(explorerStyles, /\.pin:hover \.pin-icon-selected/u);
  assert.match(explorerStyles, /\.pin\.pin-underground \{[\s\S]*--pin-size: 22px/u);
  assert.match(explorer, /const sections = Array\.isArray\(map\?\.map_sections\)/u);
  assert.match(explorer, /Number\(crop\.left\) - Number\(sourceCrop\.left\)/u);
  assert.match(explorer, /image: target\.image/u);
  assert.match(explorer, /\{ id: "all", label: "All current interiors" \}/u);
  assert.match(explorer, /const visible = showAll \|\| planElement\.dataset\.planId === selectedMode\?\.id/u);
  assert.doesNotMatch(explorer, /assets\/maps\/underground/u);
  assert.match(explorerStyles, /\.map-section-link \{[\s\S]*?background: transparent;/u);
  assert.match(explorerStyles, /\.map-underground-layer \{[\s\S]*?background: transparent;/u);
});

test("cave navigation uses the current in-game marker art rather than legacy custom arrows", () => {
  assert.match(explorer, /itemsById\?\.get\("current-poi-10600"\)\?\.icon/);
  assert.match(explorer, /map-section-label/);
  assert.match(explorer, /renderMapSections\(\);\s*updateUndergroundMapLayerVisibility\(\);\s*applyPendingSharedPinSelection/);
  assert.doesNotMatch(explorer, /map-layer-underground-(?:off|on)\.png/);
  assert.match(explorerStyles, /\.map-section-label\.is-visible\s*\{/);
});

test("Aniilog forms remain nested under one expandable species row", () => {
  assert.match(explorer, /function getAniilogGroupKey\(entry\)/u);
  assert.match(explorer, /entry\?\.family_id/u);
  assert.match(explorer, /function renderAniilogGroupedIndex\(entries, selectedId\)/u);
  assert.match(explorer, /const baseEntry = groupEntries\.find\(isAniilogBasicForm\) \|\| groupEntries\[0\]/u);
  assert.match(explorer, /className = "catalog-form-children"/u);
  assert.match(explorer, /toggle\.setAttribute\("aria-expanded", String\(expanded\)\)/u);
  assert.match(explorer, /persistAniilogExpandedGroups\(expandedGroups\)/u);
});

test("gameplay traits and Pet Manual objectives use separate catalog sections", () => {
  assert.match(explorer, /catalogAbilitySearchTerms\(entry\?\.traits\)/);
  assert.match(explorer, /catalogAbilitySearchTerms\(entry\?\.aniilog_research\)/);
  assert.match(explorer, /renderCatalogAbilitySection\("Traits", entry\.traits/);
  assert.match(explorer, /renderCatalogAbilitySection\(\s*"Aniilog Research",\s*entry\.aniilog_research/s);
  assert.ok(
    explorer.lastIndexOf('"Aniilog Research"')
      > explorer.indexOf('record.append(lowerGrid)'),
    "Aniilog Research should render after the desktop lower detail grid",
  );
});

test("mixed current Aniimo art families share one circular portrait treatment", () => {
  assert.match(explorer, /catalog-aniimo-portrait--full-body/);
  assert.match(explorerStyles, /\.catalog-aniimo-portrait\s*\{[^}]*border-radius:\s*50%/s);
  assert.match(explorerStyles, /\.catalog-aniimo-portrait--full-body\s*\{[^}]*padding:\s*3px/s);
  assert.match(explorerStyles, /\.item-row\.aniimo-row \.item-icon,[\s\S]*?border-radius:\s*50%/s);
});

test("Prismana markers expose their Nurture trigger separately from their type", () => {
  assert.match(explorer, /spawn\.spawn_mechanism \? \["Trigger", spawn\.spawn_mechanism\] : null/u);
});

test("packed PetManual videos use their lower grayscale plane as transparency", () => {
  assert.match(explorer, /ANIILOG_MEDIA_URL = contentUrl\("\.\/data\/aniilog_media\.json"\)/u);
  assert.match(explorer, /mediaByForm\.size !== payload\.entries\.length/u);
  assert.match(explorer, /function attachPackedAniimoBackdrop\(record, entry\)/u);
  assert.match(explorer, /video\.crossOrigin = "anonymous"/u);
  assert.match(explorer, /vec3 color = texture2D\(u_video, vec2\(v_uv\.x, 0\.5 \+ v_uv\.y \* 0\.5\)\)\.rgb/u);
  assert.match(explorer, /vec3 mask = texture2D\(u_video, vec2\(v_uv\.x, v_uv\.y \* 0\.5\)\)\.rgb/u);
  assert.match(explorer, /gl_FragColor = vec4\(color \* alpha, alpha\)/u);
  assert.match(explorerStyles, /\.catalog-aniimo-video-source\s*\{\s*display: none/u);
  assert.match(explorerStyles, /\.catalog-aniimo-video-backdrop\s*\{[\s\S]*?position: fixed/u);
});

test("Aniimo without verified wild locations do not offer Locate on Map", () => {
  assert.match(explorer, /if \(Array\.isArray\(entry\.map_ids\) && entry\.map_ids\.length\)/u);
  assert.doesNotMatch(explorer, /locate\.disabled = !Array\.isArray\(entry\.map_ids\)/u);
});

test("named and custom themes share one site-wide preference", () => {
  assert.match(landingHtml, /data-site-theme-select/u);
  assert.match(explorerHtml, /data-site-theme-select/u);
  assert.match(landingHtml, /class="theme-picker-copy">Theme</u);
  assert.match(explorerHtml, /class="theme-picker-copy">Theme</u);
  assert.match(landingHtml, /theme-shell\.js/u);
  assert.match(explorerHtml, /theme-shell\.js/u);
  assert.match(themeShell, /aniilogs:explorer:preferences:v1/u);
  assert.match(themeShell, /label: "AniiLogs Night"/u);
  assert.match(themeShell, /label: "AniiLogs Meadow"/u);
  assert.match(themeShell, /label: "Emberpup"/u);
  assert.match(themeShell, /label: "Pawney"/u);
  assert.match(themeShell, /theme === "custom"/u);
  assert.match(themeShell, /aniilogs:themechange/u);
  assert.match(landingStyles, /:root\[data-color-mode="light"\]/u);
  assert.match(explorer, /window\.AniiLogsTheme\?\.syncControls\(id\)/u);
  assert.doesNotMatch(explorer, /\{ id: "themes", label: "Themes" \}/u);
  assert.doesNotMatch(landingApp, /COLOR_MODE_STORAGE_KEY/u);
});

test("the shared shell uses the selected accent and Pathfinder terminology", () => {
  assert.match(landingStyles, /:root:not\(\[data-color-mode="light"\]\) nav a:hover,[\s\S]*?rgba\(var\(--accent-rgb\), 0\.13\)/u);
  assert.match(landingHtml, /tools every Pathfinder reaches for first/u);
  assert.match(landingHtml, /Pathfinder profiles/u);
  assert.match(explorerHtml, /AniiLogs Pathfinder/u);
  assert.doesNotMatch(landingHtml, /Aniimo explorers|tools every explorer|Explorer profiles/iu);
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
  assert.match(landingStyles, /@media \(max-width: 820px\)/u);
  assert.match(explorerHtml, /class="app-topbar-brand-mark"/u);
  assert.match(explorerStyles, /\.app-topbar-context\s*\{\s*display: none/u);
  assert.match(landingStyles, /\.site-header\s*\{[\s\S]*?grid-template-columns: 1fr auto 1fr/u);
  assert.match(explorerStyles, /\.app-topbar\s*\{[\s\S]*?grid-template-columns: 1fr auto 1fr/u);
  assert.match(landingStyles, /\.site-header\s*\{[^}]*background: rgba\(var\(--panel-rgb\), 0\.97\)/u);
  assert.doesNotMatch(landingStyles, /\.site-header\s*\{[^}]*background: rgba\(18, 29, 33/u);
});

test("checklist Aniimo portraits are circular and current-build Lumin guides render when supplied", () => {
  assert.match(explorer, /checklist-aniimo-portrait/u);
  assert.match(explorerStyles, /\.checklist-aniimo-portrait\s*\{[^}]*border-radius:\s*50%/su);
  assert.match(explorer, /function renderLuminGuide\(\)/u);
  assert.match(explorer, /state\.checklistData\?\.lumin_guides/u);
});

test("listed regions without a verified surface remain selectable and explain their status", () => {
  assert.doesNotMatch(explorer, /option\.disabled = map\.availability === "awaiting_current_asset"/u);
  assert.match(explorer, /map-world--unavailable/u);
  assert.match(explorer, /the current game build does not include a verified map image yet/u);
  assert.match(explorerStyles, /\.map-world--unavailable::before/u);
});

test("the page background stays viewport-fixed while mobile content scrolls", () => {
  assert.match(explorerStyles, /body::before\s*\{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/u);
  assert.match(explorerStyles, /body\s*\{[\s\S]*?isolation: isolate;[\s\S]*?background: var\(--background\);/u);
  assert.match(explorerStyles, /\.map-panel\.catalog-active\s*\{[\s\S]*?contain: none;/u);
  assert.match(explorerStyles, /\.catalog-aniimo-video-backdrop\s*\{[\s\S]*?position: fixed;[\s\S]*?object-position: center;/u);
});

test("logs are top-level sections while the Map sidebar contains only map tools", () => {
  assert.match(landingHtml, /href="\/explorer\/\?view=aniilog"[^>]*>Aniilog</u);
  assert.match(explorerHtml, /id="topNavAniilog"[^>]*>Aniilog</u);
  assert.match(explorerHtml, /id="topNavItemlog"/u);
  assert.match(explorerHtml, /id="topNavTeam"[^>]*>Team Builder</u);
  assert.match(explorerHtml, /id="aniilogWorkspaceTab"[^>]*hidden/u);
  assert.match(explorerHtml, /id="itemlogWorkspaceTab"[^>]*hidden/u);
  assert.match(explorer, /els\.workspaceTabs\.hidden = isFullPanelView\(\)/u);
  assert.match(explorer, /state\.sidebarView === "itemlog"\) els\.topNavItemlog/u);
  assert.match(explorer, /state\.sidebarView === "team"\) els\.topNavTeam/u);
});

test("Team Builder is a fluid top-level under-construction workspace", () => {
  assert.match(explorer, /ENABLED_WORKSPACE_VIEWS = new Set\(\["map", "tracking", "checklist", "itemlog", "team"\]\)/u);
  assert.match(explorer, /function renderTeamUnderConstruction\(\)/u);
  assert.match(explorer, /Under construction/u);
  assert.match(explorerHtml, /id="topNavTeam"[^>]*>Team Builder<\/a>/u);
});

test("the desktop sidebar handle stays narrow and unobtrusive", () => {
  assert.match(explorerStyles, /\.sidebar-collapse-button\s*\{[\s\S]*?width: 26px/u);
  assert.match(explorerStyles, /\.sidebar-collapse-button\s*\{[\s\S]*?min-height: 56px/u);
  assert.match(explorerStyles, /\.sidebar-restore-button\s*\{[\s\S]*?width: 26px/u);
  assert.doesNotMatch(explorerStyles, /\.sidebar-collapse-button\s*\{[\s\S]*?font-size: 34px/u);
});

test("the top-right Discord control becomes an accessible account menu", () => {
  for (const html of [landingHtml, explorerHtml]) {
    assert.match(html, /data-account-menu/u);
    assert.match(html, /data-discord-icon/u);
    assert.match(html, />My Profile</u);
    assert.match(html, />Settings</u);
    assert.match(html, /aria-label="Sign in with Discord"/u);
  }
  assert.match(themeShell, /menu\.addEventListener\("pointerenter", openForPointer\)/u);
  assert.match(themeShell, /menu\.addEventListener\("focusin", cancelClose\)/u);
  assert.match(themeShell, /event\.key !== "Escape"/u);
  assert.match(landingHtml, /data-account-sign-in/u);
  assert.match(landingApp, /accountMenu\.hidden = true/u);
  assert.match(landingApp, /accountMenu\.hidden = false/u);
  assert.match(landingApp, /const label = link\.querySelector\("span"\)/u);
  assert.doesNotMatch(landingApp, /link\.textContent = link\.classList\.contains/u);
  assert.match(explorer, /function configureTopbarAccount\(account = null\)/u);
  assert.match(explorer, /popover\.insertBefore\(els\.settingsButton, els\.topbarLogoutButton\)/u);
  assert.match(explorer, /actions\.insertBefore\(els\.settingsButton, els\.topbarSignInLink\)/u);
  assert.match(explorer, /REQUESTED_SETTINGS_OPEN/u);
  assert.match(landingStyles, /\.account-menu-popover/u);
  assert.match(explorerStyles, /\.account-menu-popover/u);
  assert.match(landingStyles, /\.account-menu-trigger\s*\{[^}]*min-height: 36px/u);
  assert.match(landingStyles, /\.account-menu-trigger\s*\{[^}]*font-size: 12px/u);
  assert.match(landingStyles, /\.discord-icon\s*\{ width: 19px; height: 19px/u);
  assert.match(explorerStyles, /\[hidden\]\s*\{\s*display: none !important;/u);
});

test("developer diagnostics and role controls are server-entitlement gated", () => {
  assert.match(explorerHtml, /id="mapMeta" class="database-meta" hidden/u);
  assert.match(explorerHtml, /id="cloudSyncLink"[^>]*hidden/u);
  assert.match(explorerHtml, /id="topbarDeveloperButton"[^>]*hidden/u);
  assert.match(explorer, /state\.developerModeAvailable && state\.preferences\.developerMode/u);
  assert.match(explorer, /if \(state\.developerModeAvailable\) options\.push/u);
  assert.match(explorer, /if \(!state\.developerAdminAvailable\) return/u);
  assert.match(explorer, /\/admin\/developers\//u);
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

test("the shared shell uses the compact typography scale from the approved map UI", () => {
  assert.match(explorerStyles, /Inter, ui-sans-serif, system-ui/u);
  assert.doesNotMatch(explorerStyles, /ui-rounded/u);
  assert.match(explorerStyles, /\.brand h1\s*\{[\s\S]*?font-size: 18px/u);
  assert.match(explorerStyles, /\.map-select\s*\{[\s\S]*?font-size: 12px/u);
  assert.match(explorerStyles, /\.catalog-heading h1\s*\{[\s\S]*?clamp\(20px, 2\.2vw, 26px\)/u);
  assert.match(explorerStyles, /\.catalog-identity h2\s*\{[\s\S]*?font-size: 19px/u);
  assert.match(explorerStyles, /\.catalog-description\s*\{[\s\S]*?font-size: 13px/u);
  assert.match(landingStyles, /Inter, ui-sans-serif, system-ui/u);
  assert.doesNotMatch(landingStyles, /ui-rounded/u);
  assert.doesNotMatch(landingStyles, /7\.4rem/u);
  assert.doesNotMatch(landingStyles, /4\.5rem/u);
  for (const styles of [landingStyles, explorerStyles]) {
    assert.match(styles, /\.theme-picker-label\s*\{[^}]*align-items: center/u);
    assert.match(styles, /\.theme-picker-label\s*\{[^}]*flex-direction: column/u);
    assert.match(styles, /\.theme-picker\s*\{[^}]*width: 7rem/u);
    assert.match(styles, /\.theme-picker\s*\{[^}]*min-height: 24px/u);
    assert.match(styles, /\.theme-picker\s*\{[^}]*text-align: center/u);
    assert.match(styles, /\.theme-picker\s*\{[^}]*text-align-last: center/u);
    assert.match(styles, /\.account-sign-in\s*\{[^}]*width: 36px/u);
  }
  assert.match(landingStyles, /clamp\(2\.5rem, 5vw, 4\.4rem\)/u);
});

test("map and filter controls remain compact as the map inventory grows", () => {
  assert.match(explorerHtml, /id="mapTabs"[^>]*aria-label="Map selection"/u);
  assert.match(explorerHtml, /class="panel item-panel"[\s\S]*?for="searchInput"[\s\S]*?id="layerTabs"/u);
  assert.match(explorer, /document\.createElement\("select"\)/u);
  assert.match(explorer, /document\.createElement\("optgroup"\)/u);
  assert.match(explorer, /select\.addEventListener\("change"/u);
  assert.match(explorerStyles, /\.map-select\s*\{[\s\S]*?height: 34px/u);
  assert.match(explorerStyles, /\.map-filter-actions\s*\{[\s\S]*?grid-template-columns:/u);
  assert.match(explorerHtml, /class="share-pins-icon"/u);
  assert.doesNotMatch(explorer, /Share current pins/u);
});

test("Travel renders current portal groups and never drops unclassified destinations", () => {
  assert.match(explorer, /\{ id: "rv_park", label: "RV Parks" \}/u);
  assert.match(explorer, /\{ id: "transporter", label: "Transporters" \}/u);
  assert.match(explorer, /\{ id: "vein_rift", label: "Vein Rifts" \}/u);
  assert.match(explorer, /groupKey: "teleport-group:other"/u);
  assert.match(explorer, /label: "Other Travel"/u);
});

test("map hover keeps the normal icon unless a selected-state replacement exists", () => {
  assert.match(explorerStyles, /\.pin:has\(\.pin-icon-selected\):hover \.pin-icon:not\(\.pin-icon-selected\)/u);
  assert.doesNotMatch(explorerStyles, /(?:^|\n)\.pin:hover \.pin-icon:not\(\.pin-icon-selected\)/u);
});

test("only species-specific Aniimo map portraits receive the circular frame", () => {
  assert.match(explorer, /spawn\.marker_type === "aniimo_spawn" && spawn\.aniimo_id \? "pin-specific-aniimo"/u);
  assert.match(explorerStyles, /\.pin\.pin-specific-aniimo \.pin-icon/u);
  assert.doesNotMatch(explorerStyles, /\.pin\.pin-aniimo-spawn \.pin-icon\s*\{/u);
});

test("special Aniimo badges are unframed and anchored at the portrait top right", () => {
  assert.match(explorer, /function specialBadgeSource\(subject, fallback = null\)/u);
  assert.match(explorer, /function iconWithSpecialBadge\(icon, subject, fallback = null, className = ""\)/u);
  assert.match(explorer, /"item-icon-badge-frame"/u);
  assert.match(explorer, /makeIcon\("aniimo-special-badge", specialBadgeSource\(spawn, item\)\)/u);
  assert.match(explorer, /context\.drawImage\(specialBadge, x \+ size \/ 2 - 15, y - size \/ 2 - 3, 18, 18\)/u);
  assert.match(explorer, /"selection-icon-badge-frame"/u);
  assert.match(explorerStyles, /\.aniimo-special-badge\s*\{[^}]*top: -3px;[^}]*right: -3px;[^}]*border-radius: 0;[^}]*background: transparent;/su);
  assert.match(explorerStyles, /\.item-icon-badge-frame > \.aniimo-special-badge,[\s\S]*?\.selection-icon-badge-frame > \.aniimo-special-badge/u);
  assert.doesNotMatch(explorerStyles, /\.aniimo-special-badge\s*\{[^}]*border-radius:\s*(?:50%|999)/su);
});

test("map selections surface the reviewed short marker descriptions", () => {
  assert.match(explorer, /const descriptionText = String\(spawn\.description \|\| item\.description \|\| ""\)\.trim\(\)/u);
  assert.match(explorer, /description\.className = "selection-description"/u);
  assert.match(explorer, /detail\.append\(title, description, grid\)/u);
  assert.match(explorerStyles, /\.selection-description\s*\{[^}]*font-size: 12px;/su);
});

test("the live UI loads only the package-pinned reviewed private content route", async () => {
  const explorerConfig = await readFile(new URL("../public/explorer/app-config.js", import.meta.url), "utf8");
  assert.match(explorerConfig, /contentAvailable: true/u);
  assert.match(explorerConfig, /const contentBaseUrl = isLocalPreview/u);
  assert.match(explorerConfig, /contentPackageVersion: 3528012/u);
  assert.match(explorerConfig, /contentRevision = "20260916-build3528012-runtime-map-icons-r9"/u);
  assert.match(explorerConfig, /aniilogs-api\.pages\.dev\/api\/content\/releases\/3528012/u);
  assert.match(explorerHtml, /id="contentUnavailable"[^>]*hidden/u);
  assert.doesNotMatch(explorerHtml, /src="https:\/\/aniilogs-api\.pages\.dev\/api\/content/u);
  assert.match(explorer, /if \(!CONTENT_AVAILABLE\)/u);
  assert.match(explorer, /Awaiting reviewed snapshot/u);
  assert.match(explorer, /`Game build \$\{CONTENT_PACKAGE_VERSION\}`/u);
  assert.doesNotMatch(explorer, /v0\.9\.4-private-content/u);
  assert.match(explorerStyles, /\.content-unavailable\[hidden\]\s*\{\s*display: none/u);
});

test("desktop map selections open beside the selected marker and remain draggable", () => {
  assert.match(explorer, /mapSelectionPlacement: "floating"/u);
  assert.match(explorer, /function positionDesktopSelectionAtAnchor\(anchor\)/u);
  assert.match(explorer, /selectSpawn\(canvasCandidate\.index, \{ clientX: event\.clientX, clientY: event\.clientY \}\)/u);
  assert.match(explorer, /setDesktopSelectionAnchor\(Number\(anchor\?\.clientX\), Number\(anchor\?\.clientY\)\)/u);
  assert.match(explorer, /desktopSelectionHeading\.addEventListener\("pointerdown", startDesktopSelectionDrag\)/u);
  assert.match(explorerStyles, /#desktopSelectionPanel\.is-floating-placement \.panel-heading\s*\{[^}]*cursor: grab;/su);
});

test("internal test items are available only to entitled developer mode", () => {
  assert.match(explorer, /const DEVELOPER_ONLY_ITEM_NAME_PATTERNS/u);
  assert.match(explorer, /Test Furniture No/u);
  assert.match(explorer, /Avatar Frame Test/u);
  assert.match(explorer, /Test Held Item/u);
  assert.match(explorer, /Test Invitation Letter/u);
  assert.match(explorer, /View All Items/u);
  assert.match(explorer, /return developerModeEnabled\(\) \? entries : entries\.filter/u);
  assert.match(explorer, /function developerModeEnabled\(\) \{\s*return Boolean\(state\.developerModeAvailable && state\.preferences\.developerMode\);/su);
  assert.match(explorer, /if \(state\.sidebarView === "itemlog"\) renderCatalogPreview\(\);/u);
});

test("game rich text is rendered with safe DOM nodes", () => {
  assert.match(explorer, /function appendGameRichText\(element, value\)/u);
  assert.match(explorer, /const tokenPattern = \/<style=/u);
  assert.ok(explorer.includes('<link="[^"]*">'));
  assert.match(explorer, /document\.createTextNode/u);
  assert.match(explorer, /appendGameRichText\(description, displayed\.description\)/u);
  assert.match(explorer, /appendGameRichText\(description, entry\.description\)/u);
  assert.match(explorerStyles, /\.game-rich-text--hint-bgl/u);
});

test("current-build RV progression is applied and rendered on item details", async () => {
  const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(worker, /patch\.item_rv_details/u);
  assert.match(worker, /entry\.rv_details = patch\.item_rv_details\[entry\.item_id\]/u);
  assert.match(explorer, /function renderRvProgression\(details\)/u);
  assert.match(explorer, /createCatalogSection\("RV progression"\)/u);
  assert.match(explorer, /renderRvProgression\(entry\.rv_details\)/u);
  assert.match(explorer, /label\.textContent = "Required materials"/u);
  assert.match(explorer, /ingredients\.forEach\(\(ingredient\) => list\.append\(renderItemlogReference\(ingredient\)\)\)/u);
  assert.match(explorerStyles, /\.catalog-rv-upgrade-grid/u);
  assert.match(explorerStyles, /\.catalog-rv-production-card/u);
});

test("current-build Held Item effects and underline markup are rendered safely", async () => {
  const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(worker, /patch\.item_held_details/u);
  assert.match(explorer, /function renderHeldItemDetails\(details\)/u);
  assert.match(explorer, /createCatalogSection\("Held Item stats & effects"\)/u);
  assert.match(explorer, /Advanced effect · Tier/u);
  assert.match(explorer, /Rune Energy/u);
  assert.match(explorer, /document\.createElement\(match\[2\] === "b"/u);
  assert.match(explorerStyles, /\.catalog-held-item-effect-card/u);
});

test("item filters retain useful quality and enriched-data facets", () => {
  assert.match(explorer, /id: "has-held-stats", label: "Equippable Held Items"/u);
  assert.match(explorer, /id: "has-rv-details", label: "Has RV requirements"/u);
  assert.match(explorer, /id: `quality:\$\{quality\}`/u);
  assert.match(explorer, /selectedSource === "has-held-stats"/u);
  assert.match(explorer, /selectedSource\.startsWith\("quality:"\)/u);
  assert.match(explorer, /Maximum enhancement/u);
  assert.match(explorer, /Base attributes at maximum/u);
});

test("Astra POIs use current map-marker art inside the in-game marker frame", () => {
  assert.match(explorer, /function isAstraMarkPointIcon\(source\)/u);
  assert.match(explorer, /pin\.classList\.add\("pin-astra-markpoint"\)/u);
  assert.match(explorer, /context\.roundRect\(x - size \/ 2, y - size \/ 2, size, size, radius\)/u);
  assert.match(explorerStyles, /\.pin-astra-markpoint \.pin-body/u);
});

test("all current Aniimo client languages are available across the site", async () => {
  const localization = await readFile(new URL("../public/explorer/localization.js", import.meta.url), "utf8");
  const landing = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const privacy = await readFile(new URL("../public/privacy.html", import.meta.url), "utf8");
  for (const locale of ["en", "de-DE", "es-ES", "fr-FR", "id-ID", "ja", "ko", "pt-PT", "ru-RU", "th-TH", "vi-VN", "zh-CN", "zh-TW"]) {
    assert.ok(localization.includes(`${locale}:`) || localization.includes(`"${locale}"`));
  }
  assert.match(localization, /const AUTO_START = document\.currentScript\?\.dataset\.autoStart === "true"/u);
  assert.match(landing, /localization\.js[^>]+data-auto-start="true"/u);
  assert.match(privacy, /localization\.js[^>]+data-auto-start="true"/u);
});

test("the flag-only header language control shares the Settings preference", async () => {
  const localization = await readFile(new URL("../public/explorer/localization.js", import.meta.url), "utf8");
  const landing = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const html of [landing, explorerHtml]) {
    assert.match(html, /class="language-picker" data-site-language-select/u);
    assert.match(html, /<option value="en">🇺🇸<\/option>/u);
    assert.match(html, /<option value="zh-TW">🇹🇼<\/option>/u);
    assert.doesNotMatch(html, /class="language-picker-label"/u);
  }
  assert.match(localization, /function setPreferredLocale\(locale, \{ reload = true \} = \{\}\)/u);
  assert.match(localization, /language: normalized/u);
  assert.match(localization, /querySelectorAll\("\[data-site-language-select\]"\)/u);
  assert.match(explorer, /languageSelect\.dataset\.siteLanguageSelect = ""/u);
  assert.match(explorer, /AniipediaI18n\.setPreferredLocale\(languageSelect\.value, \{ reload: false \}\)/u);
  assert.match(explorerStyles, /\.language-picker\s*\{[^}]*width: 38px;[^}]*appearance: none;/su);
});

test("the compact theme selector leaves room for full theme names", async () => {
  const landingStyles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(explorerStyles, /\.theme-picker\s*\{[^}]*width: 7rem;[^}]*max-width: 7rem;/su);
  assert.match(explorerStyles, /\.app-topbar-actions \.theme-picker\s*\{[^}]*width: 6\.75rem;/su);
  assert.match(landingStyles, /\.theme-picker\s*\{[^}]*width: 7rem;[^}]*max-width: 7rem;/su);
});

test("the local private-content bridge is scoped and contains no machine-specific path", () => {
  assert.match(localContentServer, /http:\/\/127\.0\.0\.1:8787/u);
  assert.match(localContentServer, /access-control-allow-origin/u);
  assert.match(localContentServer, /no-store/u);
  assert.doesNotMatch(localContentServer, /[A-Z]:\\Users\\/u);
});

test("collectable tracking remains usable without verified respawn timing", () => {
  assert.match(explorer, /return Boolean\(spawn && item && spawn\.marker_type === "collect_item"\)/u);
  assert.doesNotMatch(explorer, /if \(!id \|\| !itemId \|\| !mapId \|\| !respawnSeconds\) return null/u);
  assert.match(explorer, /"Save to Tracking"/u);
  assert.match(explorer, /"Respawn timing unavailable"/u);
  assert.match(explorer, /"Choose an item on the map"/u);
});

test("signed-in settings present cloud progress instead of browser-storage controls", () => {
  assert.match(explorer, /if \(!state\.cloudSyncAuthenticated\) \{[\s\S]*?name\.textContent = "This browser"/u);
  assert.match(explorer, /if \(state\.cloudSyncAuthenticated\) cloudAccount\.append\(cloudIdentity, stats\)/u);
  assert.match(explorer, /if \(!state\.cloudSyncAuthenticated\) appendSettingsStorageError\(settingsPanel\)/u);
  assert.match(explorer, /tracking and checklist progress sync across devices/u);
});
