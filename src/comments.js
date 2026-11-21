// Comments on runs and the notifications about them (the owner, 20 Nov; tables in migrations/0035_run_comments.sql).
//
// - One thread per run: the key is the run's shared-run group (extra.sharedRun, set when copies of a team run are
//   linked) else the submission id, so every copy of a team run opens the same thread (threadOf).
// - Anyone reads; a signed-in account writes plain text (1 to 500 characters, line breaks kept). Limits: one comment per
//   10 seconds and 30 an hour per account, and not the same text twice in a row in one thread.
// - Staff (administrator, owner) hide, delete, see reports and stop an account from commenting. The run's sender can't
//   hide others' comments.
// - Who is told about a new comment: the accounts on the run (the senders of its copies, and team-mates whose slot is
//   tied to an account by a verified or confirmed UID) and everyone who commented there; never the author, never an
//   account that turned the thread off. Kept in run_thread_members, written when a comment is posted.
//
// index.js routes /api/runs/, /api/comments/, /api/notifications and /api/admin/comments here with its own helpers
// (deps), so this file holds no account or session code of its own.

export const COMMENT_MAX_CHARS = 500;
export const COMMENT_GAP_MS = 10 * 1000;
export const COMMENT_HOURLY_LIMIT = 30;
export const REPORT_REASON_MAX = 200;
const HOUR_MS = 60 * 60 * 1000;
const THREAD_PAGE = 200;               // comments one thread shows (newest last)
const ENTRY_PAGE = 30;                 // notification entries one list shows
const THREAD_KINDS = new Set(["interlink_run", "sim_run", "eggheist_match"]);
const STAFF_ROLES = new Set(["administrator", "owner"]);
const MODE_LABELS = Object.freeze({ interlink_run: "Interlink", sim_run: "Holo-Battle Sim", eggheist_match: "Egg Heist" });
const RUN_ID = "[A-Za-z0-9_-]{8,40}";

const isStaff = (account) => Boolean(account && STAFF_ROLES.has(account.role));
const now = () => Date.now();
const placeholders = (list) => list.map(() => "?").join(", ");

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

// The text a comment is stored with: line endings made \n, other control characters dropped, trimmed. Null when it's
// empty or longer than COMMENT_MAX_CHARS characters (counted as characters, not bytes, the same way SQLite's length()
// counts them).
export function cleanCommentText(value) {
  if (typeof value !== "string") return { error: "Write something first." };
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/gu, "").trim();
  if (!text) return { error: "Write something first." };
  if ([...text].length > COMMENT_MAX_CHARS) return { error: `A comment can be at most ${COMMENT_MAX_CHARS} characters.` };
  return { text };
}

// How the site shows an account (as the boards do): its Discord name when its owner picked "Show me by: Discord",
// else its main character's name (main, then a verified one, then the latest seen), else the display name its owner lets
// players find them by, else "Pathfinder". profileId: its public profile, when public. For SQL where `who` is a column.
const nameSql = (who) => `
  (SELECT COALESCE(u.discord_global_name, u.discord_username) FROM users u JOIN profiles p ON p.discord_id = u.discord_id
    WHERE u.discord_id = ${who} AND json_extract(p.preferences_json, '$.nameShown') = 'discord') AS discordName,
  COALESCE(
    (SELECT gc.character_name FROM game_characters gc WHERE gc.discord_id = ${who} AND gc.character_name IS NOT NULL
      ORDER BY gc.game_uid IS (SELECT main.main_game_uid FROM profiles main WHERE main.discord_id = gc.discord_id) DESC,
        gc.verified_at IS NOT NULL DESC, gc.last_seen_at DESC LIMIT 1),
    (SELECT p.display_name FROM profiles p WHERE p.discord_id = ${who} AND p.findable_by_name = 1 AND p.display_name IS NOT NULL),
    'Pathfinder') AS characterName,
  (SELECT CASE WHEN p.is_public = 1 THEN p.public_id END FROM profiles p WHERE p.discord_id = ${who}) AS profileId`;
const shownName = (row) => ({
  name: String(row.discordName || row.characterName || "Pathfinder"),
  ...(row.discordName ? { discord: true } : {}),
  ...(row.profileId ? { profileId: String(row.profileId) } : {}),
});

// The run a submission id belongs to, as a thread: its key, every id a thread on it may have been stored under (the
// group and each copy: a run commented on before its copies were linked keeps its comments), and its copies.
// Null when there is no such submission or it isn't a run (a menu best, a week's total or a season rank).
export async function threadOf(env, runId) {
  const row = await env.DB.prepare(
    `SELECT submission_id AS id, discord_id AS discordId, kind, status, players_json AS playersJson,
       json_extract(extra_json, '$.sharedRun') AS sharedRun
     FROM leaderboard_submissions WHERE submission_id = ?`,
  ).bind(runId).first();
  if (!row || !THREAD_KINDS.has(row.kind)) return null;
  const key = typeof row.sharedRun === "string" && row.sharedRun ? row.sharedRun : row.id;
  let copies = [row];
  if (typeof row.sharedRun === "string" && row.sharedRun) {
    const { results } = await env.DB.prepare(
      `SELECT submission_id AS id, discord_id AS discordId, kind, status, players_json AS playersJson
       FROM leaderboard_submissions WHERE json_extract(extra_json, '$.sharedRun') = ? ORDER BY submission_id LIMIT 20`,
    ).bind(key).all();
    copies = results?.length ? results : [row];
    if (!copies.some((copy) => copy.id === row.id)) copies.push(row);
  }
  const aliases = [...new Set([key, ...copies.map((copy) => copy.id)])];
  return { key, aliases, runId: row.id, copies };
}

// Whether this account may see the thread: a run on the boards (any copy visible) for everyone; a hidden run only for
// its senders and staff.
function threadVisible(thread, account) {
  if (thread.copies.some((copy) => copy.status === "visible")) return true;
  return Boolean(account && (isStaff(account) || thread.copies.some((copy) => copy.discordId === account.discordId)));
}

// The accounts on the run: discordId -> 2 (sent a copy) or 1 (a team-mate whose slot carries a UID linked to the
// account, verified or confirmed in that party, as the boards credit team-mates).
export async function runAccounts(env, copies) {
  const accounts = new Map();
  for (const copy of copies) accounts.set(String(copy.discordId), 2);
  const slots = [];
  for (const copy of copies) {
    let players = [];
    try { players = JSON.parse(copy.playersJson || "[]"); } catch { players = []; }
    for (const slot of Array.isArray(players) ? players : []) {
      if (slot && !slot.ai && slot.uid) slots.push({ uid: String(slot.uid), confirmed: slot.confirmed === true || slot.confirmed === 1 });
    }
  }
  const uids = [...new Set(slots.map((slot) => slot.uid))].slice(0, 60);
  if (uids.length) {
    const { results } = await env.DB.prepare(
      `SELECT game_uid AS uid, discord_id AS discordId, verified_at IS NOT NULL AS verified FROM game_characters WHERE game_uid IN (${placeholders(uids)})`,
    ).bind(...uids).all();
    for (const character of results || []) {
      const tied = Number(character.verified) === 1 || slots.some((slot) => slot.uid === String(character.uid) && slot.confirmed);
      const id = String(character.discordId);
      if (tied && !accounts.has(id)) accounts.set(id, 1);
    }
  }
  return accounts;
}

// A thread stored under a copy's own id before the copies were linked moves to the group's key (comments and members),
// so the notifications read one key per thread. Run when a comment is posted.
async function settleThreadKey(env, thread) {
  const old = thread.aliases.filter((alias) => alias !== thread.key);
  if (!old.length) return;
  const list = placeholders(old);
  await env.DB.prepare(`UPDATE run_comments SET thread_key = ? WHERE thread_key IN (${list})`).bind(thread.key, ...old).run();
  await env.DB.prepare(`UPDATE OR IGNORE run_thread_members SET thread_key = ? WHERE thread_key IN (${list})`).bind(thread.key, ...old).run();
  await env.DB.prepare(`DELETE FROM run_thread_members WHERE thread_key IN (${list})`).bind(...old).run();
}

async function banned(env, discordId) {
  return Boolean(await env.DB.prepare("SELECT 1 AS banned FROM comment_bans WHERE discord_id = ?").bind(discordId).first());
}

async function memberRow(env, discordId, thread) {
  return env.DB.prepare(
    `SELECT thread_key AS threadKey, on_run AS onRun, commented, muted FROM run_thread_members
     WHERE discord_id = ? AND thread_key IN (${placeholders(thread.aliases)}) ORDER BY thread_key = ? DESC LIMIT 1`,
  ).bind(discordId, ...thread.aliases, thread.key).first();
}

// ---------------------------------------------------------------- a thread

// GET /api/runs/<id>/comments: the thread, newest last; who may do what in it.
async function getThread(request, env, deps, runId) {
  const account = await deps.currentAccount(request, env);
  const thread = await threadOf(env, runId);
  if (!thread || !threadVisible(thread, account)) return deps.json({ error: "This run isn't available." }, 404);
  const staff = isStaff(account);
  const statuses = staff ? "'visible', 'hidden'" : "'visible'";
  const viewer = account ? account.discordId : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM (SELECT c.comment_id AS id, c.discord_id AS author, c.body, c.status, c.created_at AS at, ${nameSql("c.discord_id")},
       EXISTS (SELECT 1 FROM run_comment_reports r WHERE r.comment_id = c.comment_id AND r.discord_id = ?) AS reportedByMe,
       (SELECT COUNT(*) FROM run_comment_reports r WHERE r.comment_id = c.comment_id) AS reports,
       EXISTS (SELECT 1 FROM comment_bans b WHERE b.discord_id = c.discord_id) AS authorBanned
     FROM run_comments c WHERE c.thread_key IN (${placeholders(thread.aliases)}) AND c.status IN (${statuses})
     ORDER BY c.created_at DESC, c.comment_id DESC LIMIT ${THREAD_PAGE}) ORDER BY at ASC, id ASC`,
  ).bind(viewer, ...thread.aliases).all();
  const onRun = await runAccounts(env, thread.copies);
  const comments = (results || []).map((row) => ({
    id: row.id,
    author: shownName(row),
    text: row.body,
    at: Number(row.at),
    ...(row.author === viewer ? { own: true } : {}),
    ...(onRun.has(String(row.author)) ? { onRun: true } : {}),
    ...(row.status === "hidden" ? { hidden: true } : {}),
    ...(Number(row.reportedByMe) === 1 ? { reported: true } : {}),
    ...(staff ? { reports: Number(row.reports || 0), authorBanned: Number(row.authorBanned) === 1 } : {}),
  }));
  const member = account ? await memberRow(env, account.discordId, thread) : null;
  const following = Boolean(account && (member || onRun.has(account.discordId)));
  return deps.json({
    runId: thread.runId,
    count: comments.filter((comment) => !comment.hidden).length,
    comments,
    viewer: {
      signedIn: Boolean(account),
      staff,
      banned: account ? await banned(env, account.discordId) : false,
      following,
      notifications: following ? Number(member?.muted || 0) === 0 : false,
    },
  });
}

// POST /api/runs/<id>/comments {text}
async function postComment(request, env, deps, runId) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in to comment." }, 401);
  let body;
  try {
    body = await deps.readJsonBody(request, 8 * 1024);
  } catch (error) {
    return deps.json({ error: error instanceof RangeError ? `A comment can be at most ${COMMENT_MAX_CHARS} characters.` : error.message },
      error instanceof RangeError ? 413 : 400);
  }
  const cleaned = cleanCommentText(body?.text);
  if (cleaned.error) return deps.json({ error: cleaned.error }, 400);
  const thread = await threadOf(env, runId);
  if (!thread || !threadVisible(thread, account)) return deps.json({ error: "This run isn't available." }, 404);
  if (await banned(env, account.discordId)) return deps.json({ error: "Staff have stopped this account from commenting." }, 403);
  const at = now();
  const recent = await env.DB.prepare(
    "SELECT MAX(created_at) AS last, COUNT(*) AS hour FROM run_comments WHERE discord_id = ? AND created_at > ?",
  ).bind(account.discordId, at - HOUR_MS).first();
  if (recent?.last != null && at - Number(recent.last) < COMMENT_GAP_MS) {
    return deps.json({ error: "Wait a few seconds before posting again." }, 429);
  }
  if (Number(recent?.hour || 0) >= COMMENT_HOURLY_LIMIT) {
    return deps.json({ error: `That's ${COMMENT_HOURLY_LIMIT} comments in the last hour. Try again later.` }, 429);
  }
  const previous = await env.DB.prepare(
    `SELECT body FROM run_comments WHERE discord_id = ? AND thread_key IN (${placeholders(thread.aliases)}) AND status <> 'deleted'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(account.discordId, ...thread.aliases).first();
  if (previous && previous.body === cleaned.text) return deps.json({ error: "You already posted this comment." }, 409);

  await settleThreadKey(env, thread);
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO run_comments (comment_id, thread_key, run_id, discord_id, body, status, created_at) VALUES (?, ?, ?, ?, ?, 'visible', ?)",
  ).bind(id, thread.key, thread.runId, account.discordId, cleaned.text, at).run();
  // who follows the thread from now on: the run's accounts (all of its comments are news to them) and the author
  // (what comes after their comment); a thread someone turned off stays off
  const accounts = await runAccounts(env, thread.copies);
  // a sender's entry links to their own copy of the run
  const ownCopy = (discordId) => thread.copies.find((copy) => String(copy.discordId) === discordId)?.id || thread.runId;
  const writes = [...accounts].map(([discordId, onRun]) => env.DB.prepare(
    `INSERT INTO run_thread_members (discord_id, thread_key, run_id, on_run, since_at) SELECT ?, ?, ?, ?, 0
       WHERE EXISTS (SELECT 1 FROM users WHERE discord_id = ?)
     ON CONFLICT (discord_id, thread_key) DO UPDATE SET on_run = MAX(on_run, excluded.on_run), since_at = 0,
       run_id = CASE WHEN excluded.on_run = 2 THEN excluded.run_id ELSE run_thread_members.run_id END`,
  ).bind(discordId, thread.key, onRun === 2 ? ownCopy(discordId) : thread.runId, onRun, discordId));
  writes.push(env.DB.prepare(
    `INSERT INTO run_thread_members (discord_id, thread_key, run_id, commented, read_at, marked_unread, since_at) VALUES (?, ?, ?, 1, ?, 0, ?)
     ON CONFLICT (discord_id, thread_key) DO UPDATE SET commented = 1, read_at = excluded.read_at, marked_unread = 0,
       since_at = MIN(run_thread_members.since_at, excluded.since_at)`,
  ).bind(account.discordId, thread.key, thread.runId, at, accounts.has(account.discordId) ? 0 : at));
  await env.DB.batch(writes);
  const author = await env.DB.prepare(`SELECT ${nameSql("me.discord_id")} FROM users me WHERE me.discord_id = ?`).bind(account.discordId).first();
  return deps.json({ ok: true, comment: { id, author: shownName(author || {}), text: cleaned.text, at, own: true,
    ...(accounts.has(account.discordId) ? { onRun: true } : {}) } }, 201);
}

// POST /api/runs/<id>/thread/read and /unread: the account opened the thread's comments, or marked its entry unread.
async function markThread(request, env, deps, runId, read) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  const thread = await threadOf(env, runId);
  if (!thread) return deps.json({ error: "This run isn't available." }, 404);
  const where = `WHERE discord_id = ? AND thread_key IN (${placeholders(thread.aliases)})`;
  if (read) {
    await env.DB.prepare(`UPDATE run_thread_members SET read_at = ?, marked_unread = 0 ${where}`).bind(now(), account.discordId, ...thread.aliases).run();
  } else {
    await env.DB.prepare(`UPDATE run_thread_members SET marked_unread = 1 ${where}`).bind(account.discordId, ...thread.aliases).run();
  }
  return deps.json({ ok: true });
}

// PUT /api/runs/<id>/thread/notifications {on}: turn the thread's notifications off (they stay off until turned on again)
// or back on.
async function setThreadNotifications(request, env, deps, runId) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  let body;
  try { body = await deps.readJsonBody(request, 256); } catch (error) { return deps.json({ error: error.message }, 400); }
  if (typeof body?.on !== "boolean") return deps.json({ error: "on must be true or false." }, 400);
  const thread = await threadOf(env, runId);
  if (!thread || !threadVisible(thread, account)) return deps.json({ error: "This run isn't available." }, 404);
  const member = await memberRow(env, account.discordId, thread);
  if (member) {
    await env.DB.prepare(`UPDATE run_thread_members SET muted = ? WHERE discord_id = ? AND thread_key IN (${placeholders(thread.aliases)})`)
      .bind(body.on ? 0 : 1, account.discordId, ...thread.aliases).run();
  } else {
    const onRun = (await runAccounts(env, thread.copies)).get(account.discordId);
    if (!onRun) return deps.json({ error: "You don't follow this thread." }, 409);
    await env.DB.prepare(
      "INSERT INTO run_thread_members (discord_id, thread_key, run_id, on_run, muted, since_at) VALUES (?, ?, ?, ?, ?, 0)",
    ).bind(account.discordId, thread.key, thread.runId, onRun, body.on ? 0 : 1).run();
  }
  return deps.json({ ok: true, notifications: body.on });
}

// ---------------------------------------------------------------- one comment

async function commentRow(env, commentId) {
  return env.DB.prepare(
    `SELECT comment_id AS id, discord_id AS author, status, thread_key AS threadKey, run_id AS runId FROM run_comments WHERE comment_id = ?`,
  ).bind(commentId).first();
}

// DELETE /api/comments/<id>: its author, or staff. The row stays without its text (the limits still count it).
async function deleteComment(request, env, deps, commentId) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  const row = await commentRow(env, commentId);
  if (!row || row.status === "deleted") return deps.json({ error: "This comment is gone." }, 404);
  const own = row.author === account.discordId;
  if (!own && !isStaff(account)) return deps.json({ error: "You can only delete your own comments." }, 403);
  if (own && row.status === "hidden" && !isStaff(account)) return deps.json({ error: "This comment is gone." }, 404);
  await env.DB.batch([
    env.DB.prepare("UPDATE run_comments SET status = 'deleted', body = '', moderated_by = ?, moderated_at = ? WHERE comment_id = ?")
      .bind(own ? null : account.discordId, own ? null : now(), commentId),
    env.DB.prepare("DELETE FROM run_comment_reports WHERE comment_id = ?").bind(commentId),
  ]);
  return deps.json({ ok: true });
}

// PATCH /api/comments/<id> {hidden}: staff hide a comment (kept, shown to staff only) or show it again.
async function hideComment(request, env, deps, commentId) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!isStaff(account)) return deps.json({ error: "Only staff can hide comments." }, 403);
  let body;
  try { body = await deps.readJsonBody(request, 256); } catch (error) { return deps.json({ error: error.message }, 400); }
  if (typeof body?.hidden !== "boolean") return deps.json({ error: "hidden must be true or false." }, 400);
  const row = await commentRow(env, commentId);
  if (!row || row.status === "deleted") return deps.json({ error: "This comment is gone." }, 404);
  await env.DB.prepare("UPDATE run_comments SET status = ?, moderated_by = ?, moderated_at = ? WHERE comment_id = ?")
    .bind(body.hidden ? "hidden" : "visible", account.discordId, now(), commentId).run();
  return deps.json({ ok: true, hidden: body.hidden });
}

// POST /api/comments/<id>/report {reason?}: once per account per comment, never your own.
async function reportComment(request, env, deps, commentId) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in to report a comment." }, 401);
  let body;
  try { body = await deps.readJsonBody(request, 2048); } catch (error) { return deps.json({ error: error.message }, 400); }
  const reason = typeof body?.reason === "string" ? body.reason.replace(/\s+/gu, " ").trim() : "";
  if ([...reason].length > REPORT_REASON_MAX) return deps.json({ error: `A reason can be at most ${REPORT_REASON_MAX} characters.` }, 400);
  const row = await commentRow(env, commentId);
  if (!row || row.status !== "visible") return deps.json({ error: "This comment is gone." }, 404);
  if (row.author === account.discordId) return deps.json({ error: "You can't report your own comment." }, 400);
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO run_comment_reports (comment_id, discord_id, reason, created_at) VALUES (?, ?, ?, ?)",
  ).bind(commentId, account.discordId, reason || null, now()).run();
  if (!Number(result?.meta?.changes)) return deps.json({ error: "You already reported this comment." }, 409);
  return deps.json({ ok: true });
}

// POST / DELETE /api/comments/<id>/ban: staff stop the comment's author from commenting, or undo it.
async function banAuthor(request, env, deps, commentId, ban) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!isStaff(account)) return deps.json({ error: "Only staff can stop an account from commenting." }, 403);
  const row = await commentRow(env, commentId);
  if (!row) return deps.json({ error: "This comment is gone." }, 404);
  return setBan(env, deps, account, row.author, ban);
}

async function setBan(env, deps, account, discordId, ban) {
  if (ban) {
    if (discordId === account.discordId) return deps.json({ error: "You can't stop your own account." }, 400);
    if (await staffAccount(env, deps, discordId)) return deps.json({ error: "Staff accounts can't be stopped from commenting." }, 403);
    await env.DB.prepare("INSERT OR IGNORE INTO comment_bans (discord_id, banned_by, created_at) VALUES (?, ?, ?)")
      .bind(discordId, account.discordId, now()).run();
  } else {
    await env.DB.prepare("DELETE FROM comment_bans WHERE discord_id = ?").bind(discordId).run();
  }
  return deps.json({ ok: true, banned: ban });
}

async function staffAccount(env, deps, discordId) {
  return STAFF_ROLES.has(await deps.roleOf(discordId, env));
}

// ---------------------------------------------------------------- staff lists

// GET /api/admin/comments/reports: reported comments still up (visible or hidden), most reported first.
async function listReports(request, env, deps) {
  const account = await deps.currentAccount(request, env);
  if (!isStaff(account)) return deps.json({ error: "Staff access required." }, 403);
  const { results } = await env.DB.prepare(
    `SELECT c.comment_id AS id, c.run_id AS runId, c.body, c.status, c.created_at AS at, c.discord_id AS authorId, ${nameSql("c.discord_id")},
       COUNT(r.discord_id) AS reports, MAX(r.created_at) AS lastReportAt,
       json_group_array(r.reason) AS reasonsJson
     FROM run_comments c JOIN run_comment_reports r ON r.comment_id = c.comment_id
     WHERE c.status IN ('visible', 'hidden')
     GROUP BY c.comment_id ORDER BY reports DESC, lastReportAt DESC LIMIT 200`,
  ).all();
  return deps.json({
    comments: (results || []).map((row) => {
      let reasons = [];
      try { reasons = JSON.parse(row.reasonsJson || "[]").filter((reason) => typeof reason === "string" && reason); } catch { reasons = []; }
      return { id: row.id, runId: row.runId, text: row.body, hidden: row.status === "hidden", at: Number(row.at),
        author: { ...shownName(row), discordId: String(row.authorId) }, reports: Number(row.reports), reasons: reasons.slice(0, 10),
        lastReportAt: Number(row.lastReportAt) };
    }),
  });
}

// GET /api/admin/comments/bans: accounts stopped from commenting, newest first.
async function listBans(request, env, deps) {
  const account = await deps.currentAccount(request, env);
  if (!isStaff(account)) return deps.json({ error: "Staff access required." }, 403);
  const { results } = await env.DB.prepare(
    `SELECT b.discord_id AS discordId, b.created_at AS at, ${nameSql("b.discord_id")} FROM comment_bans b ORDER BY b.created_at DESC LIMIT 500`,
  ).all();
  return deps.json({ bans: (results || []).map((row) => ({ discordId: String(row.discordId), ...shownName(row), at: Number(row.at) })) });
}

// DELETE /api/admin/comments/bans/<discordId>
async function liftBan(request, env, deps, discordId) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!isStaff(account)) return deps.json({ error: "Staff access required." }, 403);
  return setBan(env, deps, account, discordId, false);
}

// ---------------------------------------------------------------- notifications

// The threads with news for an account: not turned off, with a visible comment by someone else after the account
// started following (since_at) and after the entry was last opened. after: also after this (SQL) time, for the number:
// the list's last opening.
const NEWS = (after) => `EXISTS (SELECT 1 FROM run_comments c WHERE c.thread_key = m.thread_key AND c.status = 'visible'
  AND c.discord_id <> m.discord_id AND c.created_at > MAX(m.since_at, COALESCE(m.read_at, 0)${after ? `, ${after}` : ""}))`;

async function notificationCount(env, discordId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM run_thread_members m
     WHERE m.discord_id = ?1 AND m.muted = 0
       AND ${NEWS("COALESCE((SELECT seen_at FROM notification_seen WHERE discord_id = ?1), 0)")}`,
  ).bind(discordId).first();
  return Number(row?.count || 0);
}

// GET /api/notifications/count: the number on the account button (signed in only).
async function getCount(request, env, deps) {
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  return deps.json({ count: await notificationCount(env, account.discordId) });
}

// A run's short title for an entry: its mode, boss (training, difficulty) and score or time.
function runTitle(row, deps) {
  if (!row) return "A run";
  const parts = [MODE_LABELS[row.kind] || "Run"];
  const name = row.kind === "sim_run" ? (row.trial ? deps.simTrialName?.(row.trial, row.difficulty, row.cycle) || row.trial : null)
    : row.kind === "eggheist_match" ? row.difficulty : row.bossName;
  if (name) parts.push(String(name));
  if (row.kind === "sim_run" && Number.isFinite(Number(row.clearTimeS)) && row.clearTimeS !== null) {
    const seconds = Math.round(Number(row.clearTimeS));
    parts.push(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
  } else if (Number.isFinite(Number(row.score)) && row.score !== null) {
    parts.push(Number(row.score).toLocaleString("en-US"));
  }
  return parts.join(" · ");
}

// GET /api/notifications: one entry per thread, newest activity first. Each names who commented (since the entry was
// last opened when it has news, else since the account started following), how the account is tied to the run, the
// run's title, the latest time, and whether the entry is unread.
async function listNotifications(request, env, deps) {
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  const me = account.discordId;
  const { results: threads } = await env.DB.prepare(
    `SELECT * FROM (SELECT m.thread_key AS threadKey, m.run_id AS runId, m.on_run AS onRun, m.commented, m.read_at AS readAt,
       m.marked_unread AS markedUnread, m.since_at AS sinceAt,
       (SELECT MAX(c.created_at) FROM run_comments c WHERE c.thread_key = m.thread_key AND c.status = 'visible'
          AND c.discord_id <> m.discord_id AND c.created_at > m.since_at) AS latestAt
     FROM run_thread_members m WHERE m.discord_id = ? AND m.muted = 0)
     WHERE latestAt IS NOT NULL ORDER BY latestAt DESC LIMIT ${ENTRY_PAGE}`,
  ).bind(me).all();
  const list = threads || [];
  const entries = [];
  if (list.length) {
    const keys = list.map((thread) => thread.threadKey);
    const { results: actors } = await env.DB.prepare(
      `SELECT c.thread_key AS threadKey, c.discord_id AS who, MAX(c.created_at) AS at, ${nameSql("c.discord_id")}
       FROM run_comments c WHERE c.thread_key IN (${placeholders(keys)}) AND c.status = 'visible' AND c.discord_id <> ?
       GROUP BY c.thread_key, c.discord_id`,
    ).bind(...keys, me).all();
    const runIds = [...new Set(list.map((thread) => thread.runId))];
    const { results: runs } = await env.DB.prepare(
      `SELECT submission_id AS id, kind, boss_name AS bossName, trial, difficulty, cycle, score, clear_time_s AS clearTimeS
       FROM leaderboard_submissions WHERE submission_id IN (${placeholders(runIds)})`,
    ).bind(...runIds).all();
    const runOf = new Map((runs || []).map((row) => [row.id, row]));
    for (const thread of list) {
      const latestAt = Number(thread.latestAt);
      const readAfter = Math.max(Number(thread.sinceAt || 0), Number(thread.readAt || 0));
      const news = latestAt > readAfter;
      const after = news ? readAfter : Number(thread.sinceAt || 0);
      const people = (actors || []).filter((row) => row.threadKey === thread.threadKey && Number(row.at) > after)
        .sort((a, b) => Number(b.at) - Number(a.at));
      entries.push({
        runId: thread.runId,
        relation: Number(thread.onRun) === 2 ? "sender" : Number(thread.onRun) === 1 ? "player" : "commenter",
        // "A", "A and B", "A and 2 others"
        actors: people.slice(0, people.length > 2 ? 1 : 2).map(shownName),
        others: people.length > 2 ? people.length - 1 : 0,
        title: runTitle(runOf.get(thread.runId), deps),
        at: latestAt,
        unread: news || Number(thread.markedUnread) === 1,
      });
    }
  }
  return deps.json({ count: await notificationCount(env, me), entries });
}

// POST /api/notifications/seen: the list was opened; the number starts again from zero.
async function markSeen(request, env, deps) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  await env.DB.prepare(
    "INSERT INTO notification_seen (discord_id, seen_at) VALUES (?, ?) ON CONFLICT (discord_id) DO UPDATE SET seen_at = excluded.seen_at",
  ).bind(account.discordId, now()).run();
  return deps.json({ ok: true, count: 0 });
}

// POST /api/notifications/read-all: every entry marked as read.
async function readAll(request, env, deps) {
  if (!deps.browserWriteAllowed(request, env)) return deps.json({ error: "Cross-origin request denied." }, 403);
  const account = await deps.currentAccount(request, env);
  if (!account) return deps.json({ error: "Sign in first." }, 401);
  await env.DB.prepare("UPDATE run_thread_members SET read_at = ?, marked_unread = 0 WHERE discord_id = ?")
    .bind(now(), account.discordId).run();
  return deps.json({ ok: true });
}

// ---------------------------------------------------------------- routes

export function commentsPath(pathname) {
  return pathname.startsWith("/api/runs/") || pathname.startsWith("/api/comments/")
    || pathname === "/api/notifications" || pathname.startsWith("/api/notifications/")
    || pathname.startsWith("/api/admin/comments/");
}

// deps: index.js's own currentAccount, json, readJsonBody, browserWriteAllowed, roleOf(discordId, env) and
// simTrialName(trial, difficulty, cycle).
export async function commentsApi(request, env, deps) {
  if (!env.DB) return deps.json({ error: "Comments are unavailable." }, 503);
  const { pathname } = new URL(request.url);
  const method = request.method;
  let match = pathname.match(new RegExp(`^/api/runs/(${RUN_ID})/(comments|thread/read|thread/unread|thread/notifications)$`, "u"));
  if (match) {
    const [, runId, part] = match;
    if (part === "comments" && method === "GET") return getThread(request, env, deps, runId);
    if (part === "comments" && method === "POST") return postComment(request, env, deps, runId);
    if (part === "thread/read" && method === "POST") return markThread(request, env, deps, runId, true);
    if (part === "thread/unread" && method === "POST") return markThread(request, env, deps, runId, false);
    if (part === "thread/notifications" && method === "PUT") return setThreadNotifications(request, env, deps, runId);
    return deps.json({ error: "Not found" }, 404);
  }
  match = pathname.match(new RegExp(`^/api/comments/(${RUN_ID})(/report|/ban)?$`, "u"));
  if (match) {
    const [, commentId, action] = match;
    if (!action && method === "DELETE") return deleteComment(request, env, deps, commentId);
    if (!action && method === "PATCH") return hideComment(request, env, deps, commentId);
    if (action === "/report" && method === "POST") return reportComment(request, env, deps, commentId);
    if (action === "/ban" && (method === "POST" || method === "DELETE")) return banAuthor(request, env, deps, commentId, method === "POST");
    return deps.json({ error: "Not found" }, 404);
  }
  if (pathname === "/api/notifications" && method === "GET") return listNotifications(request, env, deps);
  if (pathname === "/api/notifications/count" && method === "GET") return getCount(request, env, deps);
  if (pathname === "/api/notifications/seen" && method === "POST") return markSeen(request, env, deps);
  if (pathname === "/api/notifications/read-all" && method === "POST") return readAll(request, env, deps);
  if (pathname === "/api/admin/comments/reports" && method === "GET") return listReports(request, env, deps);
  if (pathname === "/api/admin/comments/bans" && method === "GET") return listBans(request, env, deps);
  match = pathname.match(/^\/api\/admin\/comments\/bans\/(\d{15,22})$/u);
  if (match && method === "DELETE") return liftBan(request, env, deps, match[1]);
  return deps.json({ error: "Not found" }, 404);
}
