// Comments on runs and their notifications (src/comments.js, migrations/0035_run_comments.sql). Every account, name,
// UID and run here is made up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import worker from "../src/index.js";
import { cleanCommentText } from "../src/comments.js";

const ORIGIN = "https://aniilogs.github.io";
// sender: sent the run; mate: a team-mate whose UID is verified to their account; pal: a team-mate confirmed in the
// party only; outsider: nobody on the run; admin: administrator; owner: the owner (ADMIN_DISCORD_IDS); dev: developer
const IDS = {
  sender: "100000000000000001", mate: "100000000000000002", pal: "100000000000000003", outsider: "100000000000000004",
  admin: "100000000000000005", owner: "100000000000000006", dev: "100000000000000007", other: "100000000000000008",
};
const SESSIONS = Object.fromEntries(Object.keys(IDS).map((key, index) => [key, String.fromCharCode(97 + index).repeat(48)]));
const NAMES = { sender: "Kestrel", mate: "Mossback", pal: "Pim", outsider: "Juno", admin: "Orrin", owner: "Wren", dev: "Tamsin", other: "Bramble" };

async function tokenHash(token) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Buffer.from(digest).toString("base64url");
}

let clock = Date.now();
const realNow = Date.now;
function tick(ms = 11_000) { clock += ms; }

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = resolve(import.meta.dirname, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) sqlite.exec(readFileSync(resolve(dir, file), "utf8"));
  const statement = (sql, values = []) => ({
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
  });
  const DB = {
    prepare(sql) {
      return { ...statement(sql), bind: (...values) => {
        if (values.length > 100) throw new Error(`D1_ERROR: too many SQL variables (${values.length})`);
        return statement(sql, values);
      } };
    },
    async batch(list) { const out = []; for (const item of list) out.push(await item.run()); return out; },
  };
  const t = Math.floor(realNow() / 1000);
  for (const [key, id] of Object.entries(IDS)) {
    sqlite.prepare("INSERT INTO users VALUES (?, ?, ?, NULL, ?, ?)").run(id, key, null, t, t);
    sqlite.prepare("INSERT INTO profiles (discord_id, display_name, bio, is_public, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)").run(id, key, t, t);
    sqlite.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(await tokenHash(SESSIONS[key]), id, t, t + 86400 * 30);
    sqlite.prepare("INSERT INTO game_characters (game_uid, discord_id, character_name, source, linked_at, last_seen_at, verified_at) VALUES (?, ?, ?, 'meter', ?, ?, ?)")
      .run(`9000000${Object.keys(IDS).indexOf(key)}`, id, NAMES[key], t, t, key === "pal" ? null : t);
  }
  sqlite.prepare("INSERT INTO developer_roles (discord_id, role, granted_by_discord_id, created_at) VALUES (?, 'administrator', ?, ?)").run(IDS.admin, IDS.owner, t);
  sqlite.prepare("INSERT INTO developer_roles (discord_id, role, granted_by_discord_id, created_at) VALUES (?, 'developer', ?, ?)").run(IDS.dev, IDS.owner, t);
  const env = { DB, PUBLIC_SITE_ORIGIN: ORIGIN, ADMIN_DISCORD_IDS: IDS.owner };
  return { env, sqlite };
}

// a run: players = slots (uid, confirmed), extra = extra_json fields
function addRun(sqlite, id, sender, { players = [], extra = {}, kind = "interlink_run", status = "visible", score = 98450 } = {}) {
  const t = Math.floor(realNow() / 1000);
  sqlite.prepare(`INSERT INTO leaderboard_submissions (submission_id, discord_id, mode, kind, client_run_id, cycle, boss_id, boss_name, score,
      players_json, extra_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '3005', 'b1', 'Test Boss', ?, ?, ?, ?, ?, ?)`)
    .run(id, IDS[sender], kind.startsWith("sim") ? "sim" : kind.startsWith("egg") ? "eggheist" : "interlink", kind, `run-${id}`, score,
      JSON.stringify(players), JSON.stringify(extra), status, t, t);
}
const slot = (key, extra = {}) => ({ name: NAMES[key], ai: false, uid: `9000000${Object.keys(IDS).indexOf(key)}`, ...extra });

function call(env, path, { as, method = "GET", body, origin = ORIGIN } = {}) {
  const headers = new Headers();
  if (as) headers.set("authorization", `Bearer ${SESSIONS[as]}`);
  if (origin && method !== "GET") headers.set("origin", origin);
  if (body !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`https://api.aniilogs.example${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}
async function post(env, run, as, text) {
  tick();
  return call(env, `/api/runs/${run}/comments`, { as, method: "POST", body: { text } });
}
const count = async (env, as) => (await (await call(env, "/api/notifications/count", { as })).json()).count;
const list = async (env, as) => (await call(env, "/api/notifications", { as })).json();
const thread = async (env, run, as) => (await call(env, `/api/runs/${run}/comments`, { as })).json();

// a team run sent by sender, with mate (verified UID) and pal (UID confirmed in the party)
function teamRun(sqlite) {
  addRun(sqlite, "RunAAAA0001", "sender", { players: [slot("sender", { self: true }), slot("mate"), slot("pal", { confirmed: true })] });
}

test.before(() => { Date.now = () => clock; });
test.after(() => { Date.now = realNow; });

test("comment text: trimmed, line breaks kept, control characters dropped, 1 to 500 characters", () => {
  assert.deepEqual(cleanCommentText("  hi\r\nthere  "), { text: "hi\nthere" });
  assert.equal(cleanCommentText("a\u0000b‮c").text, "abc");
  assert.ok(cleanCommentText("   ").error);
  assert.ok(cleanCommentText(42).error);
  assert.equal(cleanCommentText("é".repeat(500)).text.length, 500);
  assert.ok(cleanCommentText("x".repeat(501)).error);
});

test("anyone reads; signed out, banned, empty, too long and a missing run are refused on the server", async () => {
  const { env, sqlite } = await setup();
  teamRun(sqlite);
  assert.equal((await post(env, "RunAAAA0001", null, "hello")).status, 401);
  assert.equal((await post(env, "RunAAAA0001", "outsider", "   ")).status, 400);
  assert.equal((await post(env, "RunAAAA0001", "outsider", "x".repeat(501))).status, 400);
  assert.equal((await post(env, "RunMissing01", "outsider", "hello")).status, 404);
  // a week total isn't a run: no thread
  addRun(sqlite, "WeekAAAA0001", "sender", { kind: "interlink_week" });
  assert.equal((await post(env, "WeekAAAA0001", "outsider", "hello")).status, 404);
  const created = await post(env, "RunAAAA0001", "outsider", "Which Aniimo did you lead with?\nNice.");
  assert.equal(created.status, 201);
  // from another site: refused
  tick();
  assert.equal((await call(env, "/api/runs/RunAAAA0001/comments", { as: "outsider", method: "POST", body: { text: "x" }, origin: "https://elsewhere.example" })).status, 403);
  const signedOut = await thread(env, "RunAAAA0001", null);
  assert.equal(signedOut.count, 1);
  assert.equal(signedOut.comments[0].text, "Which Aniimo did you lead with?\nNice.");
  assert.equal(signedOut.comments[0].author.name, "Juno");
  assert.equal(signedOut.viewer.signedIn, false);
  assert.equal(signedOut.comments[0].own, undefined);
  assert.equal((await call(env, "/api/runs/RunMissing01/comments")).status, 404);
  // a hidden run: only its sender and staff see the thread
  addRun(sqlite, "RunHidden001", "sender", { status: "hidden" });
  assert.equal((await call(env, "/api/runs/RunHidden001/comments", { as: "outsider" })).status, 404);
  assert.equal((await call(env, "/api/runs/RunHidden001/comments", { as: "sender" })).status, 200);
  assert.equal((await call(env, "/api/runs/RunHidden001/comments", { as: "admin" })).status, 200);
});

test("limits: one comment per 10 seconds, 30 an hour, and not the same text twice in a row in one thread", async () => {
  const { env, sqlite } = await setup();
  teamRun(sqlite);
  addRun(sqlite, "RunBBBB0001", "other");
  assert.equal((await post(env, "RunAAAA0001", "outsider", "first")).status, 201);
  tick(5_000);   // only 5 s after the last
  const quick = await call(env, "/api/runs/RunAAAA0001/comments", { as: "outsider", method: "POST", body: { text: "second" } });
  assert.equal(quick.status, 429);
  assert.match((await quick.json()).error, /Wait a few seconds/u);
  const twice = await post(env, "RunAAAA0001", "outsider", "first");
  assert.equal(twice.status, 409);
  assert.match((await twice.json()).error, /already posted/u);
  // the same text in another thread is fine
  assert.equal((await post(env, "RunBBBB0001", "outsider", "first")).status, 201);
  for (let i = 2; i < 30; i += 1) assert.equal((await post(env, "RunAAAA0001", "outsider", `comment ${i}`)).status, 201, `comment ${i}`);
  const over = await post(env, "RunAAAA0001", "outsider", "one too many");
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /30 comments in the last hour/u);
  // deleting doesn't give the hour back
  const { comments } = await thread(env, "RunAAAA0001", "outsider");
  assert.equal((await call(env, `/api/comments/${comments[0].id}`, { as: "outsider", method: "DELETE" })).status, 200);
  assert.equal((await post(env, "RunAAAA0001", "outsider", "still too many")).status, 429);
  tick(60 * 60 * 1000);
  assert.equal((await post(env, "RunAAAA0001", "outsider", "an hour later")).status, 201);
});

test("who is told: the run's accounts and commenters, never the author, never a turned-off thread; one entry per thread", async () => {
  const { env, sqlite } = await setup();
  teamRun(sqlite);
  assert.equal((await post(env, "RunAAAA0001", "outsider", "Clean run.")).status, 201);
  assert.equal(await count(env, "outsider"), 0);           // the author
  assert.equal(await count(env, "sender"), 1);             // sent the run
  assert.equal(await count(env, "mate"), 1);               // verified UID on the run
  assert.equal(await count(env, "pal"), 1);                // UID confirmed in the party
  assert.equal(await count(env, "admin"), 0);              // nobody to this run
  assert.equal((await call(env, "/api/notifications/count")).status, 401);

  let sender = await list(env, "sender");
  assert.equal(sender.entries.length, 1);
  assert.deepEqual(sender.entries[0].actors.map((a) => a.name), ["Juno"]);
  assert.equal(sender.entries[0].relation, "sender");
  assert.equal(sender.entries[0].title, "Interlink · Test Boss · 98,450");
  assert.equal(sender.entries[0].unread, true);
  assert.equal((await list(env, "mate")).entries[0].relation, "player");

  // a second and third person: still one entry, "A and B", then "A and 2 others"
  await post(env, "RunAAAA0001", "mate", "Thanks!");
  sender = await list(env, "sender");
  assert.equal(sender.entries.length, 1);
  assert.deepEqual(sender.entries[0].actors.map((a) => a.name), ["Mossback", "Juno"]);
  assert.equal(sender.entries[0].others, 0);
  await post(env, "RunAAAA0001", "other", "GG");
  sender = await list(env, "sender");
  assert.deepEqual(sender.entries[0].actors.map((a) => a.name), ["Bramble"]);
  assert.equal(sender.entries[0].others, 2);
  // the first commenter now follows: told about the later ones, as "also commented"
  const outsider = await list(env, "outsider");
  assert.equal(outsider.entries[0].relation, "commenter");
  assert.deepEqual(outsider.entries[0].actors.map((a) => a.name), ["Bramble", "Mossback"]);

  // opening the list clears the number; the entry stays unread until opened
  assert.equal(await count(env, "sender"), 1);
  assert.equal((await call(env, "/api/notifications/seen", { as: "sender", method: "POST" })).status, 200);
  assert.equal(await count(env, "sender"), 0);
  assert.equal((await list(env, "sender")).entries[0].unread, true);
  await call(env, "/api/runs/RunAAAA0001/thread/read", { as: "sender", method: "POST" });
  assert.equal((await list(env, "sender")).entries[0].unread, false);
  await call(env, "/api/runs/RunAAAA0001/thread/unread", { as: "sender", method: "POST" });
  assert.equal((await list(env, "sender")).entries[0].unread, true);
  assert.equal(await count(env, "sender"), 0);             // marking unread doesn't bring the number back
  await call(env, "/api/notifications/read-all", { as: "sender", method: "POST" });
  assert.equal((await list(env, "sender")).entries[0].unread, false);

  // turned off: no number, no entry, until turned on again
  assert.equal((await call(env, "/api/runs/RunAAAA0001/thread/notifications", { as: "mate", method: "PUT", body: { on: false } })).status, 200);
  await post(env, "RunAAAA0001", "outsider", "Again tomorrow?");
  assert.equal(await count(env, "mate"), 0);
  assert.equal((await list(env, "mate")).entries.length, 0);
  assert.equal((await thread(env, "RunAAAA0001", "mate")).viewer.notifications, false);
  assert.equal(await count(env, "sender"), 1);
  await call(env, "/api/runs/RunAAAA0001/thread/notifications", { as: "mate", method: "PUT", body: { on: true } });
  assert.equal(await count(env, "mate"), 1);
  // the run's player can turn a thread off before anyone else commented; an outsider has nothing to turn off
  addRun(sqlite, "RunCCCC0001", "sender");
  assert.equal((await call(env, "/api/runs/RunCCCC0001/thread/notifications", { as: "sender", method: "PUT", body: { on: false } })).status, 200);
  await post(env, "RunCCCC0001", "outsider", "Nice");
  assert.equal((await list(env, "sender")).entries.some((entry) => entry.runId === "RunCCCC0001"), false);
  assert.equal((await call(env, "/api/runs/RunCCCC0001/thread/notifications", { as: "admin", method: "PUT", body: { on: false } })).status, 409);
});

test("a team run's copies share one thread, also when they were linked after the first comment", async () => {
  const { env, sqlite } = await setup();
  addRun(sqlite, "CopyAAAA0001", "sender", { players: [slot("sender", { self: true }), slot("mate")] });
  assert.equal((await post(env, "CopyAAAA0001", "outsider", "Before the copies were linked")).status, 201);
  // the mate's copy arrives and the copies are linked (the group's id is the smallest member id)
  addRun(sqlite, "CopyAAAA0000", "mate", { players: [slot("sender"), slot("mate", { self: true })], extra: { sharedRun: "CopyAAAA0000" } });
  sqlite.prepare("UPDATE leaderboard_submissions SET extra_json = json_set(extra_json, '$.sharedRun', 'CopyAAAA0000') WHERE submission_id = 'CopyAAAA0001'").run();
  const fromSender = await thread(env, "CopyAAAA0001", null);
  const fromMate = await thread(env, "CopyAAAA0000", null);
  assert.equal(fromSender.count, 1);
  assert.deepEqual(fromMate.comments.map((c) => c.id), fromSender.comments.map((c) => c.id));
  await post(env, "CopyAAAA0000", "other", "From the other copy");
  assert.deepEqual((await thread(env, "CopyAAAA0001", null)).comments.map((c) => c.text), ["Before the copies were linked", "From the other copy"]);
  const rows = sqlite.prepare("SELECT DISTINCT thread_key AS key FROM run_comments").all();
  assert.deepEqual(rows.map((row) => row.key), ["CopyAAAA0000"]);
  assert.equal((await list(env, "sender")).entries.length, 1);
  assert.equal((await list(env, "outsider")).entries.length, 1);
  // both senders are "on this run"
  const tagged = await thread(env, "CopyAAAA0001", null);
  await post(env, "CopyAAAA0001", "mate", "Mine too");
  assert.equal((await thread(env, "CopyAAAA0001", null)).comments.at(-1).onRun, true);
  assert.equal(tagged.comments[0].onRun, undefined);
});

test("delete own, report others', staff hide/delete/ban; deleted and hidden comments stop counting", async () => {
  const { env, sqlite } = await setup();
  teamRun(sqlite);
  await post(env, "RunAAAA0001", "outsider", "rude words");
  await post(env, "RunAAAA0001", "mate", "Clean run.");
  let view = await thread(env, "RunAAAA0001", "mate");
  const [rude, clean] = view.comments;
  assert.equal(clean.own, true);
  assert.equal(clean.onRun, true);
  // only its author (or staff) deletes; the run's sender can't hide or delete others'
  assert.equal((await call(env, `/api/comments/${clean.id}`, { as: "sender", method: "DELETE" })).status, 403);
  assert.equal((await call(env, `/api/comments/${rude.id}`, { as: "sender", method: "PATCH", body: { hidden: true } })).status, 403);
  assert.equal((await call(env, `/api/comments/${rude.id}`, { as: "dev", method: "PATCH", body: { hidden: true } })).status, 403);
  // reports: once per account, never your own, an optional reason
  assert.equal((await call(env, `/api/comments/${rude.id}/report`, { as: "sender", method: "POST", body: { reason: "Insults" } })).status, 200);
  assert.equal((await call(env, `/api/comments/${rude.id}/report`, { as: "sender", method: "POST", body: {} })).status, 409);
  assert.equal((await call(env, `/api/comments/${rude.id}/report`, { as: "outsider", method: "POST", body: {} })).status, 400);
  assert.equal((await call(env, `/api/comments/${rude.id}/report`, { method: "POST", body: {} })).status, 401);
  assert.equal((await thread(env, "RunAAAA0001", "sender")).comments[0].reported, true);
  // staff see what was reported
  assert.equal((await call(env, "/api/admin/comments/reports", { as: "dev" })).status, 403);
  const reports = await (await call(env, "/api/admin/comments/reports", { as: "admin" })).json();
  assert.equal(reports.comments.length, 1);
  assert.equal(reports.comments[0].reports, 1);
  assert.deepEqual(reports.comments[0].reasons, ["Insults"]);
  assert.equal((await thread(env, "RunAAAA0001", "admin")).comments[0].reports, 1);
  assert.equal((await thread(env, "RunAAAA0001", "sender")).comments[0].reports, undefined);

  // hidden: kept for staff, gone for everyone else, out of the count and the notifications
  assert.equal(await count(env, "sender"), 1);
  assert.equal((await call(env, `/api/comments/${rude.id}`, { as: "admin", method: "PATCH", body: { hidden: true } })).status, 200);
  assert.equal((await thread(env, "RunAAAA0001", "sender")).comments.length, 1);
  assert.equal((await thread(env, "RunAAAA0001", "outsider")).comments.length, 1);
  view = await thread(env, "RunAAAA0001", "admin");
  assert.equal(view.comments[0].hidden, true);
  assert.equal(view.count, 1);
  assert.deepEqual((await list(env, "sender")).entries[0].actors.map((a) => a.name), ["Mossback"]);
  assert.equal((await call(env, `/api/comments/${rude.id}`, { as: "owner", method: "PATCH", body: { hidden: false } })).status, 200);
  assert.equal((await thread(env, "RunAAAA0001", null)).count, 2);

  // stop an account from commenting, and undo it; staff can't be stopped
  assert.equal((await call(env, `/api/comments/${rude.id}/ban`, { as: "sender", method: "POST" })).status, 403);
  assert.equal((await call(env, `/api/comments/${rude.id}/ban`, { as: "admin", method: "POST" })).status, 200);
  const blocked = await post(env, "RunAAAA0001", "outsider", "let me in");
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /stopped this account/u);
  assert.equal((await thread(env, "RunAAAA0001", "outsider")).viewer.banned, true);
  assert.equal((await thread(env, "RunAAAA0001", "admin")).comments[0].authorBanned, true);
  const bans = await (await call(env, "/api/admin/comments/bans", { as: "owner" })).json();
  assert.deepEqual(bans.bans.map((ban) => ban.discordId), [IDS.outsider]);
  assert.equal((await call(env, `/api/admin/comments/bans/${IDS.outsider}`, { as: "admin", method: "DELETE" })).status, 200);
  assert.equal((await post(env, "RunAAAA0001", "outsider", "back again")).status, 201);
  await post(env, "RunAAAA0001", "admin", "Staff here");
  view = await thread(env, "RunAAAA0001", "owner");
  const staffComment = view.comments.find((c) => c.text === "Staff here");
  assert.equal((await call(env, `/api/comments/${staffComment.id}/ban`, { as: "owner", method: "POST" })).status, 403);
  assert.equal((await call(env, `/api/comments/${staffComment.id}/ban`, { as: "admin", method: "POST" })).status, 400);   // own

  // deleted: by its author, or by staff; gone from the thread, the count and the notifications
  assert.equal((await call(env, `/api/comments/${clean.id}`, { as: "mate", method: "DELETE" })).status, 200);
  assert.equal((await call(env, `/api/comments/${rude.id}`, { as: "owner", method: "DELETE" })).status, 200);
  assert.equal((await call(env, `/api/comments/${rude.id}`, { as: "owner", method: "DELETE" })).status, 404);
  view = await thread(env, "RunAAAA0001", null);
  assert.deepEqual(view.comments.map((c) => c.text), ["back again", "Staff here"]);
  assert.equal(sqlite.prepare("SELECT body FROM run_comments WHERE comment_id = ?").get(rude.id).body, "");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM run_comment_reports").get().n, 0);
  const actors = (await list(env, "sender")).entries[0].actors.map((a) => a.name);
  assert.ok(!actors.includes("Mossback"));
});

test("deleting an account takes its comments, reports and notification settings with it", async () => {
  const { env, sqlite } = await setup();
  teamRun(sqlite);
  await post(env, "RunAAAA0001", "outsider", "hello");
  const [comment] = (await thread(env, "RunAAAA0001", null)).comments;
  await call(env, `/api/comments/${comment.id}/report`, { as: "mate", method: "POST", body: {} });
  await call(env, "/api/notifications/seen", { as: "outsider", method: "POST" });
  assert.equal((await call(env, "/api/account", { as: "outsider", method: "DELETE", body: { confirmation: "DELETE" } })).status, 200);
  for (const table of ["run_comments", "run_comment_reports", "notification_seen"]) {
    assert.equal(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM run_thread_members WHERE discord_id = ?").get(IDS.outsider).n, 0);
  assert.equal(await count(env, "sender"), 0);
});

test("a thread for each run kind that is a run, and a short title for each", async () => {
  const { env, sqlite } = await setup();
  addRun(sqlite, "SimAAAA00001", "sender", { kind: "sim_run", score: null });
  sqlite.prepare("UPDATE leaderboard_submissions SET clear_time_s = 125 WHERE submission_id = 'SimAAAA00001'").run();
  addRun(sqlite, "EggAAAA00001", "sender", { kind: "eggheist_match", score: 1200 });
  sqlite.prepare("UPDATE leaderboard_submissions SET difficulty = 'Hard' WHERE submission_id = 'EggAAAA00001'").run();
  await post(env, "SimAAAA00001", "outsider", "fast");
  await post(env, "EggAAAA00001", "outsider", "lots of loot");
  const titles = (await list(env, "sender")).entries.map((entry) => entry.title).sort();
  assert.deepEqual(titles, ["Egg Heist · Hard · 1,200", "Holo-Battle Sim · 2:05"]);
});
