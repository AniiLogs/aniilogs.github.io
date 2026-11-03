import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const linkSource = await read("../public/aniimo-link.js");
const app = await read("../public/explorer/app.js");
const teamBuilder = await read("../public/explorer/team-builder.js");
const duel = await read("../public/explorer/duel.js");
const guidePage = await read("../public/explorer/guide-page.js");
const picker = await read("../public/explorer/aniimo-picker.js");
const leaderboard = await read("../public/leaderboard/leaderboard.js");
const home = await read("../public/app.js");

// Just enough DOM for aniimo-link.js: elements that keep attributes and listeners.
function fakeElement(tag) {
  const listeners = {};
  return {
    tagName: tag.toUpperCase(), className: "", href: "", title: "", innerHTML: "", textContent: "", dataset: {},
    attributes: {}, children: [], listeners,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    append(...nodes) { this.children.push(...nodes); },
  };
}

function loadLinks(pathname = "/explorer/") {
  const head = fakeElement("head");
  const document = {
    head, documentElement: head,
    createElement: fakeElement,
    getElementById: (id) => head.children.find((node) => node.id === id) || null,
  };
  const window = { location: { pathname } };
  vm.runInNewContext(linkSource, { window, document, encodeURIComponent });
  return { links: window.AniilogsAniimoLink, head };
}

function fire(link, type, init = {}) {
  const event = {
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, stopped: false,
    ...init,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  for (const handler of link.listeners[type] || []) handler(event);
  return event;
}

test("every Aniimo's address is /explorer/?aniimo=<form id> (or a name the Aniilog resolves)", () => {
  const { links } = loadLinks();
  assert.equal(links.url("1005100"), "/explorer/?aniimo=1005100");
  assert.equal(links.url("aniimo:1005101"), "/explorer/?aniimo=1005101");
  assert.equal(links.url("Flame Ruff"), "/explorer/?aniimo=Flame%20Ruff");
  assert.equal(links.url(""), "");
  assert.equal(links.url(null), "");
});

test("the take-me-there icon is a real, labelled link that never also clicks what it sits in", () => {
  const { links, head } = loadLinks();
  const opened = [];
  links.setNavigator((id) => opened.push(id));
  const link = links.create("1005100", "Emberpup");
  assert.equal(link.tagName, "A");
  assert.equal(link.href, "/explorer/?aniimo=1005100");
  assert.equal(link.getAttribute("aria-label"), "Open Emberpup in the Aniilog");
  assert.equal(link.title, "Open Emberpup in the Aniilog");
  assert.match(link.innerHTML, /<svg[^>]+aria-hidden="true"/u);
  // One shared stylesheet, themed by the site's colour variables.
  assert.equal(head.children.filter((node) => node.id === "aniimo-link-style").length, 1);
  assert.match(head.children[0].textContent, /var\(--accent/u);

  // A picker chooses on mousedown and a card acts on click or Enter: the link keeps all of those.
  assert.equal(fire(link, "mousedown").stopped, true);
  assert.equal(fire(link, "pointerdown").stopped, true);
  assert.equal(fire(link, "keydown", { key: "Enter" }).stopped, true);

  // A plain click inside the explorer opens the page in place (one history entry)...
  const plain = fire(link, "click");
  assert.equal(plain.stopped, true);
  assert.equal(plain.defaultPrevented, true);
  assert.deepEqual(opened, ["1005100"]);
  // ...a modified or middle click is left to the browser (new tab, new window).
  for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    const event = fire(link, "click", init);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.stopped, true);
  }
  assert.equal(opened.length, 1);
  // Middle-button mousedown isn't cancelled (that would stop the new tab).
  assert.equal(fire(link, "mousedown", { button: 1 }).defaultPrevented, false);
});

test("outside the explorer the icon is followed as an ordinary link", () => {
  const { links } = loadLinks("/leaderboard/");
  const opened = [];
  links.setNavigator((id) => opened.push(id));
  const event = fire(links.create("Emberpup", "Emberpup"), "click");
  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(opened, []);
  assert.equal(links.create("", ""), null);
});

test("the explorer reads the address on load, keeps it in step and answers Back/Forward", () => {
  // ?aniimo= alone opens the Aniilog; older ?view=aniilog&aniimo= links still work.
  assert.match(app, /REQUESTED_ANIIMO_KEY && !INITIAL_URL_PARAMS\.get\("view"\) && ENABLED_WORKSPACE_VIEWS\.has\("aniilog"\) \? "aniilog" : "map"/u);
  assert.match(app, /pendingAniimoName: REQUESTED_ANIIMO_KEY && !REQUESTED_ANIIMO_FORM_ID/u);
  // Real navigations push, after saving the scroll position of the page being left.
  assert.match(app, /function pushAddress\(url, historyState = null\) \{[\s\S]*?rememberScrollPosition\(\);\s*window\.history\.pushState/u);
  assert.match(app, /function openAniimoPage\(key[\s\S]*?pushAddress\(url, \{ workspaceView: "aniilog", aniimo: id \}\)/u);
  // The shown Aniimo only rewrites the entry (filters, a form picked in the viewer).
  assert.match(app, /function syncAniimoAddress\(entry\) \{[\s\S]*?window\.history\.replaceState\(window\.history\.state, "", url\)/u);
  assert.match(app, /if \(view === "aniilog"\) syncAniimoAddress\(selected\);/u);
  assert.match(app, /window\.addEventListener\("popstate", applyAddressFromHistory\);/u);
  assert.match(app, /function applyAddressFromHistory\(event\) \{[\s\S]*?selectAniimoFromAddress\(key\)[\s\S]*?AniilogsTeamBuilder\?\.applyAddress\?\.\(\)[\s\S]*?restoreScrollPosition\(event\?\.state\?\.scroll/u);
  assert.match(app, /AniilogsAniimoLink\?\.setNavigator\(\(key\) => openAniimoPage\(key\)\)/u);
  // Sections opened from the tabs and the map's "Open in Aniilog" are history entries too.
  assert.match(app, /els\.teamWorkspaceTab\.addEventListener\("click", \(\) => showWorkspaceView\("team"\)\)/u);
  assert.match(app, /if \(view === "aniilog"\) \{\s*openAniimoPage\(entry\.id\);/u);
  // A list row, an evolution step, a form and a recommended partner all open the Aniimo's page.
  assert.match(app, /if \(view === "aniilog"\) openAniimoPage\(entry\.id, \{ scrollIndex: false \}\);/u);
  assert.match(app, /function openAniilogRecord\(entryId\) \{\s*openAniimoPage\(entryId\);/u);
  // A name in the address becomes the Basic Form's id.
  assert.match(app, /function resolvePendingAniimoName\(\) \{[\s\S]*?aniilogFormKey\(form\.form_key\) === "basic"/u);
});

test("the Team Builder tab lives in the address and Back returns to it", () => {
  assert.match(teamBuilder, /pageFromAddress\(\) \|\| \(\["types", "duel", "guide"\]\.includes\(saved\?\.page\)/u);
  assert.match(teamBuilder, /url\.searchParams\.set\("tab", page\);[\s\S]*?host\.pushAddress\(url/u);
  assert.match(teamBuilder, /function goToPage\(page\) \{\s*if \(viewState\.page !== page\) writePageAddress\(true, page\);/u);
  assert.match(teamBuilder, /const control = button\(label, "team-mode-button", \(\) => goToPage\(id\)\);/u);
  assert.match(teamBuilder, /window\.AniilogsTeamBuilder = Object\.freeze\(\{ show, applyAddress \}\);/u);
  assert.match(app, /dataUrl: TEAM_BUILDER_DATA_URL,\s*pushAddress,/u);
});

test("the leaderboard pushes board changes and restores them on Back", () => {
  assert.match(leaderboard, /const push = state\.push && url\.href !== window\.location\.href;/u);
  assert.match(leaderboard, /window\.history\.pushState\(null, "", url\)/u);
  assert.match(leaderboard, /window\.addEventListener\("popstate", async \(event\) => \{[\s\S]*?readUrl\(\);[\s\S]*?await loadEntries\(\);[\s\S]*?window\.scrollTo\(0, scroll\)/u);
  for (const trigger of [/state\.push = true;\s*state\.kind = kind;/u, /state\.push = true;\s*state\.mode = tab\.dataset\.modeTab;/u,
    /state\.push = true;\s*state\.returnWeek = state\.week;/u]) assert.match(leaderboard, trigger);
});

test("the take-me-there icon is next to every Aniimo the site names", () => {
  // Team Builder: slots, the overview cards, the picker, the open member, partners, type matchups.
  assert.match(teamBuilder, /const slotLink = form \? aniimoLink\(member\.formId, entry, form\) : null;/u);
  assert.match(teamBuilder, /AniilogsAniimoLink\.wrapCorner\(card, member\.formId/u);
  assert.match(teamBuilder, /if \(option\.value\) item\.dataset\.aniimoLink = option\.value;/u);
  assert.match(teamBuilder, /withLink\(el\("h2", "", entry\?\.name \|\| form\.name\), aniimoLink\(member\.formId, entry, form\)\)/u);
  assert.match(teamBuilder, /if \(!extra\) withLink\(name, aniimoLink\(partner\.formId, entry, form\)\);/u);
  assert.match(teamBuilder, /AniilogsAniimoLink\?\.inline\(pick, member\.formId/u);
  assert.match(teamBuilder, /withLink\(el\("strong", "", entry\?\.name \|\| form\.name\), aniimoLink\(formId, entry, form\)\)/u);
  assert.match(teamBuilder, /AniilogsGuidePage\.render\(\{ aniilog \}\)/u);
  // The picker shows an option's link without picking it.
  assert.match(picker, /entry\.option\.dataset\.aniimoLink && window\.AniilogsAniimoLink\?\.create\(entry\.option\.dataset\.aniimoLink/u);
  // 1v1: both sides' picks, their options, and the buff sources.
  assert.match(duel, /option\.dataset\.aniimoLink = formId;/u);
  assert.match(duel, /const link = model\.entry && window\.AniilogsAniimoLink\?\.create\(String\(model\.entry\.form_id\)/u);
  assert.match(duel, /const source = entry && window\.AniilogsAniimoLink\?\.create/u);
  // The Try-Hard Guide links the Aniimo its text names.
  assert.match(guidePage, /node\.append\(linkedEl\("p", "", text\)\)/u);
  assert.match(guidePage, /line\.append\(linkedEl\(index === 0 \? "th" : "td", "", String\(cell\)\)\)/u);
  // Explorer: Item-log "Involves", recommended partners, evolution, forms, checklist, map pin and tracking.
  assert.match(app, /list\.append\(aniimoLinkPair\(open, aniimo\.id, aniimo\.name\)\);/u);
  assert.match(app, /list\.append\(partner\.published \? aniimoLinkPair\(button, partner\.id, partner\.name\) : button\);/u);
  assert.match(app, /if \(!isCurrent\) \{\s*const link = window\.AniilogsAniimoLink\?\.create/u);
  assert.match(app, /row\.append\(form\.id === entry\.id \? button : aniimoLinkPair\(button, form\.id/u);
  assert.equal((app.match(/appendChecklistAniimoLink\(name, entry\);/gu) || []).length, 2);
  assert.match(app, /const aniimoLink = mapItemAniimoLink\(item, spawn\.display_name\);/u);
  assert.match(app, /const trackedLink = mapItemAniimoLink\(state\.data\?\.itemsById\?\.get\(entry\.item_id\)/u);
  // Leaderboard teams and profile run lineups (names only: the Aniilog resolves them).
  assert.match(leaderboard, /member\.name \? window\.AniilogsAniimoLink\?\.create\(member\.name, member\.name\) : null/u);
  assert.match(home, /const link = entry\.aniimo \? window\.AniilogsAniimoLink\?\.create\(entry\.aniimo, entry\.aniimo\) : null;/u);
  assert.match(home, /chip\.href = window\.AniilogsAniimoLink\?\.url\(id\)/u);
});

test("every page that names an Aniimo loads aniimo-link.js before the scripts that use it", async () => {
  const pages = [
    ["../public/explorer/index.html", /aniimo-link\.js\?v=[^"]+"><\/script>[\s\S]*aniimo-picker\.js[\s\S]*team-builder\.js[\s\S]*app\.js/u],
    ["../public/leaderboard/index.html", /aniimo-link\.js\?v=[^"]+" defer><\/script>[\s\S]*leaderboard\.js/u],
    ["../public/index.html", /aniimo-link\.js\?v=[^"]+" defer><\/script>[\s\S]*\/app\.js/u],
  ];
  for (const [page, order] of pages) assert.match(await read(page), order, page);
});
