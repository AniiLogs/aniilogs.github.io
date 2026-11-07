import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const home = read("index.html");
const boards = read("leaderboard/index.html");
const sidebar = read("site-sidebar.js");
const sidebarCss = read("site-sidebar.css");
const app = read("app.js");
const leaderboard = read("leaderboard/leaderboard.js");

test("the site sidebar loads on the Leaderboards and the Profiles pages, before the page's own script", () => {
  for (const [page, own, mode] of [[home, "/app.js", "profile"], [boards, "/leaderboard/leaderboard.js", "always"]]) {
    assert.match(page, /<link rel="stylesheet" href="\/site-sidebar\.css\?v=[\w.-]+">/u);
    assert.match(page, /<script src="\/site-sidebar\.js\?v=[\w.-]+" defer><\/script>/u);
    assert.match(page, new RegExp(`<body class="site-chrome-page" data-site-sidebar="${mode}">`, "u"));
    // after the site config (it reads the API address), before the page's script (which uses AniiSite.playerName)
    assert.ok(page.indexOf("/explorer/app-config.js") < page.indexOf("/site-sidebar.js"));
    assert.ok(page.indexOf("/site-sidebar.js") < page.indexOf(`${own}?v=`));
  }
  // on the home page only for a profile view (?view=profile or ?profile=<id>)
  assert.match(sidebar, /want === "profile" && profileView/u);
  assert.match(sidebar, /params\.get\("view"\) === "profile" \|\| params\.has\("profile"\)/u);
});

test("Online now and Recently joined left the profile's cards for the sidebar", () => {
  assert.doesNotMatch(home, /data-profile-directory|data-directory-online|data-directory-recent/u);
  assert.doesNotMatch(app, /loadProfileDirectory|profiles\/directory/u);
  assert.match(sidebar, /\/profiles\/directory/u);
  assert.match(sidebar, /addPanel\("online", "Online now"\)/u);
  assert.match(sidebar, /addPanel\("recent", "Recently joined"\)/u);
  assert.match(sidebar, /"profile-presence", row\.state === "afk" \? "AFK" : "Online"/u);    // the same status pills
  assert.match(sidebar, /keep their profile out of these lists/u);                           // the "others" count
});

test("the phone strip is a real button that says what it opens", () => {
  assert.match(sidebar, /element\("button", "site-sidebar-toggle"\)/u);
  assert.match(sidebar, /setAttribute\("aria-expanded", "false"\)/u);
  assert.match(sidebar, /setAttribute\("aria-controls", "site-sidebar-panels"\)/u);
  assert.match(sidebar, /panels\.id = "site-sidebar-panels"/u);
  assert.match(sidebar, /joined this week/u);
  assert.match(sidebarCss, /\.site-sidebar:not\(\.is-docked\):not\(\.is-open\) \.site-sidebar-panels \{ display: none; \}/u);
  assert.match(sidebarCss, /@media \(min-width: 1200px\)[\s\S]*\.site-sidebar-toggle \{ display: none; \}|\.site-sidebar-toggle \{ display: none; \}/u);
});

test("no inline styles: the sidebar and the Discord mark use classes only (the site's CSP)", () => {
  for (const source of [sidebar, home, boards]) {
    assert.doesNotMatch(source, /\sstyle="/u);
    assert.doesNotMatch(source, /<style[\s>]/u);
  }
  assert.doesNotMatch(sidebar, /\.style\.|setAttribute\("style"|innerHTML/u);
  assert.match(sidebar, /setAttribute\("class", "discord-name-mark"\)/u);
  assert.match(sidebarCss, /\.discord-name-mark \{/u);
});

test("Show me by: a choice in Edit profile, and every page draws a Discord name with the logo", () => {
  assert.match(home, /<select name="nameShown" data-profile-name-shown>\s*<option value="game">My in-game name<\/option>\s*<option value="discord">My Discord name<\/option>/u);
  assert.match(app, /nameShown: profileNameShown\.value/u);
  assert.match(app, /shownName\(overview\.profile\?\.displayName \|\| "My profile", overview\.profile\?\.nameSource\)/u);
  assert.match(app, /shownName\(result\.displayName, result\.nameSource\)/u);
  assert.match(leaderboard, /entry\.discordName \? profileName\(entry\.discordName/u);
  assert.match(sidebar, /playerName\(row\.name, row\.nameSource\)/u);
  assert.match(read("privacy.html"), /Your Discord name is shown only if you choose it/u);
});
