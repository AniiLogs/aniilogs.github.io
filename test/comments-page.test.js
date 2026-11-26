// The page side of comments and notifications: every page with the account menu loads the one notifications script,
// comments are only ever put on the page as text, and a run link opens the viewer on its Comments tab.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const PAGES = ["index.html", "companion/index.html", "guides/index.html", "leaderboard/index.html", "explorer/index.html",
  "updates/3934365/index.html", "updates/3973445/index.html", "updates/3989635/index.html",
  "updates/4047363/index.html"];

test("every page with the account menu loads notifications.js and its styles once", () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(html, /data-account-menu/u, page);
    assert.equal(html.match(/<script [^>]*src="\/notifications\.js\?v=0\.1\.0"/gu)?.length, 1, page);
    assert.equal(html.match(/href="\/notifications\.css\?v=0\.1\.0"/gu)?.length, 1, page);
  }
  // the pages with the run viewer load its Comments tab and the site's loader
  for (const page of ["index.html", "leaderboard/index.html"]) {
    const html = read(page);
    assert.match(html, /href="\/comments\.css\?v=0\.1\.0"/u, page);
    assert.match(html, /src="\/icons\/alogs-loader\.js\?v=0\.4\.0"/u, page);
  }
});

test("comments and notification text are set as text, never as HTML; loading uses the aLogs loader", () => {
  for (const file of ["comments.js", "notifications.js"]) {
    const source = read(file);
    // the only innerHTML is fixed icon markup
    for (const [, value] of source.matchAll(/\.innerHTML = ([^;]+);/gu)) assert.match(value, /^('<svg|markup$)/u, `${file}: ${value}`);
    assert.doesNotMatch(source, /insertAdjacentHTML|outerHTML|document\.write/u, file);
    assert.match(source, /AlogsLoader\?\.create\(/u, file);
  }
  const comments = read("comments.js");
  assert.match(comments, /el\("p", \{ class: "cm-text", text: comment\.text \}\)/u);
  assert.match(comments, /"Sign in to comment"/u);
  assert.match(read("comments.css"), /\.cm-text \{[^}]*white-space: pre-wrap/u);
});

test("notifications ask only while signed in and the tab is visible, about once a minute", () => {
  const source = read("notifications.js");
  assert.match(source, /const POLL_MS = 60 \* 1000;/u);
  assert.match(source, /if \(!signedIn\(\) \|\| document\.visibilityState !== "visible"\) return;/u);
  assert.match(source, /`\/leaderboard\/\?run=\$\{encodeURIComponent\(runId\)\}&tab=comments`/u);
  assert.doesNotMatch(source, /serviceWorker|PushManager|Notification\.requestPermission/u);
});

test("a run link opens the viewer on the tab it names; the Comments tab can be picked from outside", () => {
  const boards = read("leaderboard/leaderboard.js");
  assert.match(boards, /function openRunFromUrl\(\)/u);
  assert.match(boards, /proofViewer\.open\(runId, null, null, \{ \.\.\.\(tab \? \{ tab \} : \{\}\), link: \{ run: runId, ladder, code \} \}\)/u);
  const viewer = read("proof-viewer.js");
  assert.match(viewer, /options\?\.tab === "comments"/u);
  assert.match(viewer, /window\.AniilogsComments\.mount\(commentsRun\)/u);
});

test("run checks for staff: on every page with the account menu, text only, the aLogs loader, the server decides who sees it", () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.equal(html.match(/<script [^>]*src="\/run-checks\.js\?v=0\.1\.0"/gu)?.length, 1, page);
    assert.equal(html.match(/href="\/run-checks\.css\?v=0\.1\.0"/gu)?.length, 1, page);
  }
  const source = read("run-checks.js");
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/u);
  assert.match(source, /AlogsLoader\?\.create\(/u);
  // the entry shows only once the API answered the count (403 for anyone but staff)
  assert.match(source, /response\.status === 403\) \{ staff = false; stop\(\); return; \}/u);
  assert.match(source, /hidden: true, "data-run-checks-open": ""/u);
  // what each decision does is said in the list
  assert.match(source, /Either way it stays on the boards\./u);
  assert.match(source, /nothing on the boards changes\./u);
  // the boards' legend says what the badges mean now
  assert.match(read("leaderboard/leaderboard.js"), /no badge: not confirmed by either/u);
});
