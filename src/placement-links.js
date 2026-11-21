// game-audit: n/a share links to board placements; the figures come from the boards (src/index.js)
// Short links to a placement on an Interlink boss board (migration 0037): https://aniilogs-api.pages.dev/<code>.
// - POST /api/links { run, ladder, player? } gives the placement's link, making it the first time (no sign-in; only a
//   run on a board gets one, and the same placement always gets the same code).
// - GET /<code>: a link-preview crawler (Discord, Reddit, X, iMessage...) gets a small page of Open Graph tags with the
//   placement as the board shows it now; a person is sent on to the boards with that run open.
// - GET /api/links/<code>.png: the 1200x630 card in those tags (src/placement-card.js), drawn once per look and kept
//   in R2 under the placement and everything the picture shows.
const CARD_WIDTH = 1200; const CARD_HEIGHT = 630;                // src/placement-card.js draws it (deps.drawCard)

// letters and digits that can't be mistaken for each other (no 0/o, 1/l/i)
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 5;
export const PLACEMENT_CODE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u;
export const PLACEMENT_PATH = /^\/([23456789abcdefghjkmnpqrstuvwxyz]{5})\/?$/u;
export const PLACEMENT_CARD_PATH = /^\/api\/links\/([23456789abcdefghjkmnpqrstuvwxyz]{5})\.png$/u;
const RUN_ID = /^[A-Za-z0-9_-]{8,40}$/u;
const BOARDS_PATH = "/leaderboard/";
const FULL_ROWS = 25;                                    // a "View all" page (public/leaderboard/leaderboard.js)

// The ladders, as the boards name them; proof: which of a row's figures (and its run) the ladder ranks
export const PLACEMENT_LADDERS = Object.freeze({
  score: { label: "Score", proof: "score" },
  stars: { label: "Stars", proof: "score" },
  clear: { label: "Fastest clear", proof: "clear" },
  teamDps: { label: "Team DPS", proof: "teamDps" },
  dps: { label: "Avg DPS", proof: "dps", one: true, key: "avgDps" },
  break: { label: "BREAK damage", proof: "break", one: true, key: "breakValue" },
  heal: { label: "Healing", proof: "heal", one: true, key: "heal" },
});

// Solo / Duo / Trio: a run that had fewer than four real players, bots filling the rest (who is a bot: src/bots.js,
// realPlayersOf). A full team gets none. It's information only: it never changes a place.
export const TEAM_TAGS = Object.freeze({ 1: "Solo", 2: "Duo", 3: "Trio" });

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const number = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value).toLocaleString("en-US"));
function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return null;
  const total = Math.round(Number(seconds));
  const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const secs = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}
// How the run ended, as the boards say it (clearText in leaderboard.js)
function resultText(entry, twoBosses) {
  const time = entry.runTimeS ?? entry.clearTimeS;
  if (entry.outcome === "unconfirmed") return duration(time);
  const killed = twoBosses ? "Both Killed" : "Boss Killed";
  const ending = entry.outcome === "ended-early" ? "Early Exit" : entry.outcome === "cleared" ? killed
    : entry.outcome === "time-up" ? "Timed Out" : entry.clearTimeS != null ? killed : time != null ? "Timed Out" : null;
  if (!ending) return "Menu proof";
  return time == null ? ending : `${ending}: ${duration(time)}`;
}
// "Week of Nov 18 – Nov 25", as the boards name a week (in UTC here)
function weekText(week) {
  if (!week?.start || !week?.end) return null;
  const day = (unix) => new Date(unix * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `Week of ${day(week.start)} – ${day(week.end)}`;
}
const nameOf = (entry) => entry.discordName || entry.player || "Pathfinder";
// The preview's sentence for a run with bots (the tag itself counts real players)
const TAG_SENTENCES = Object.freeze({ 1: "Solo: one player and three bots.", 2: "Duo: two players and two bots.", 3: "Trio: three players and a bot." });
// The card's players: every player of the run as its viewer lists them (the run's lineup: bots marked AI, a player whose
// name the site leaves out as "Player"), highest Avg DPS first, no Avg DPS last. On a one-player ladder the placement's
// player is marked (added if the run's list doesn't name them). A run with no list: the board row's players.
const dpsOf = (entry) => (entry.avgDps == null || !Number.isFinite(Number(entry.avgDps)) ? null : Number(entry.avgDps));
const byDps = (a, b) => (dpsOf(a) === null ? (dpsOf(b) === null ? 0 : 1) : dpsOf(b) === null ? -1 : dpsOf(b) - dpsOf(a));
export function cardPlayers({ ladder, lead, members, lineup }) {
  const listed = Array.isArray(lineup) ? lineup.filter((entry) => entry && (entry.name || entry.aniimo || entry.unnamed)) : [];
  if (!listed.length) return [...members].sort(byDps).map((entry) => ({ name: nameOf(entry), dps: number(dpsOf(entry)), mark: Boolean(ladder.one) }));
  const who = String(lead.player || "").toLowerCase();
  const rows = listed.map((entry) => ({ name: entry.name ? String(entry.name) : "Player", avgDps: dpsOf(entry), ai: entry.ai === true,
    mark: Boolean(ladder.one) && Boolean(entry.name) && String(entry.name).toLowerCase() === who }));
  if (ladder.one && !rows.some((row) => row.mark)) rows.unshift({ name: nameOf(lead), avgDps: dpsOf(lead), ai: false, mark: true });
  rows.sort(byDps);
  const shown = rows.slice(0, 4);
  if (ladder.one && !shown.some((row) => row.mark)) shown[3] = rows.find((row) => row.mark);   // the placement's player always shows
  return shown.map(({ name, avgDps, ai, mark }) => ({ name, dps: number(avgDps), ...(ai ? { ai: true } : {}), mark }));
}
const listNames = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

export function createPlacementLinks({ boardData, copyGroupSql, json, browserWriteAllowed, readJsonBody, siteOrigin, drawCard, runPlayers = null }) {
  // the run a link was made for, and every copy of it (one Interlink run sent by each of its players)
  async function runOf(env, submissionId) {
    const run = await env.DB.prepare(
      `SELECT s.submission_id AS id, s.cycle, s.boss_id AS bossId, s.kind, s.status, ${copyGroupSql("s")} AS grp
       FROM leaderboard_submissions s WHERE s.submission_id = ?`,
    ).bind(submissionId).first();
    if (!run || run.status !== "visible" || !["interlink_run", "interlink_best"].includes(run.kind) || !run.cycle || !run.bossId) return null;
    const { results } = await env.DB.prepare(
      `SELECT s.submission_id AS id FROM leaderboard_submissions s WHERE ${copyGroupSql("s")} = ? LIMIT 50`,
    ).bind(run.grp).all();
    return { ...run, copies: new Set([run.id, ...(results || []).map((row) => row.id)]) };
  }

  // The placement as the board shows it now: the board everyone sees first (every server, linked players), ranked by
  // the ladder, team ladders by team rows. Null when the run isn't on it (any more).
  async function placement(env, link) {
    const ladder = PLACEMENT_LADDERS[link.ladder];
    if (!ladder || !RUN_ID.test(String(link.submissionId))) return null;
    const run = await runOf(env, link.submissionId);
    if (!run) return null;
    const params = new URLSearchParams({ cycle: String(run.cycle), boss: String(run.bossId), ladder: link.ladder });
    if (!ladder.one) params.set("rows", "teams");
    const data = await boardData(env, params);
    const boss = data?.bosses?.find((item) => String(item.id) === String(run.bossId));
    if (!boss) return null;
    const onRun = boss.entries.filter((entry) => run.copies.has(entry.proofIds?.[ladder.proof]));
    let lead; let members;
    if (ladder.one) {
      lead = onRun.find((entry) => String(entry.player || "").toLowerCase() === link.player);
      members = lead ? [lead] : [];
    } else {
      // copies read differently can be two team rows: the one with the asked copy, else the higher one
      const team = (onRun.find((entry) => entry.proofIds?.[ladder.proof] === link.submissionId) || onRun[0])?.team;
      members = team === undefined ? [] : boss.entries.filter((entry) => entry.team === team);
      lead = members[0];
    }
    if (!lead) return null;
    const listed = (data.cycle?.bosses || []).find((item) => String(item.id) === String(boss.id));
    const bossName = listed?.second?.name ? `${listed.name || boss.name} + ${listed.second.name}` : boss.name;
    // where the row is on "View all" (25 a page: team rows on team ladders, players on the others)
    const index = ladder.one ? boss.entries.indexOf(lead) : lead.team - 1;
    const proofId = lead.proofIds?.[ladder.proof] || link.submissionId;
    // every player of the run, as its viewer lists them (bots too): not only the board row's credited players
    const lineup = runPlayers ? await runPlayers(env, proofId) : null;
    return { ladder, ladderId: link.ladder, run, boss, bossName, twoBosses: Boolean(listed?.second), week: data.cycle, lead, members, lineup,
      place: lead.rank, offset: Math.max(0, Math.floor(index / FULL_ROWS) * FULL_ROWS), proofId };
  }

  // What the card and the preview say
  function describe(found) {
    const { ladder, ladderId, lead, members } = found;
    const realPlayers = members.map((entry) => entry.realPlayers).find(Boolean) || null;
    const tag = TEAM_TAGS[realPlayers] || null;
    const stars = Number.isFinite(Number(lead.stars)) && lead.stars !== null ? Number(lead.stars) : null;
    const score = number(lead.score);
    let figure; let extra; let sentence;
    if (ladderId === "clear") {
      figure = duration(lead.clearTimeS); extra = score ? `Score ${score}` : null;
      sentence = `cleared in ${figure}${stars !== null ? ` with ${stars} stars` : ""}`;
    } else if (ladderId === "teamDps") {
      figure = number(lead.teamDps); extra = score ? `Score ${score}` : null;
      sentence = `Team DPS ${figure}${stars !== null ? `, ${stars} stars` : ""}`;
    } else if (ladder.one) {
      figure = number(lead[ladder.key]); extra = score ? `Score ${score}` : null;
      sentence = `${ladder.label} ${figure}${stars !== null ? `, in a run with ${stars} stars` : ""}`;
    } else {
      figure = score; extra = number(lead.teamDps) ? `Team DPS ${number(lead.teamDps)}` : null;
      sentence = `${score}${stars !== null ? ` with ${stars} stars` : ""}`;
    }
    const players = cardPlayers(found);
    const week = weekText(found.week);
    const slot = found.boss.slot || null;
    const result = resultText(lead, found.twoBosses);
    const title = [`#${found.place} on ${ladder.label}`, found.bossName, week].filter(Boolean).join(" · ");
    const names = listNames(players.map((player) => `${player.name}${player.ai ? " (AI)" : ""}`));
    const description = [`${names}: ${sentence || figure || "on the board"}.`, tag ? TAG_SENTENCES[realPlayers] : null,
      result ? `${result}.` : null, extra ? `${extra}.` : null, `Holo-Battle Interlink${slot ? `, ${slot} boss` : ""}.`].filter(Boolean).join(" ");
    const card = { place: found.place, ladder: ladder.label, figure: figure || "–", boss: found.bossName, slot, week, stars,
      result, extra, tag, players };
    return { title, description, card };
  }

  async function cardKey(code, card) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(card))));
    const hash = [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return { hash, key: `placement-cards/${code}/${card.place}-${hash}.png` };
  }

  async function linkOf(env, code) {
    if (!PLACEMENT_CODE.test(String(code))) return null;
    return env.DB.prepare("SELECT code, submission_id AS submissionId, ladder, player FROM placement_links WHERE code = ?").bind(code).first();
  }

  function boardsUrl(env, found, code) {
    const params = new URLSearchParams({ mode: "interlink", kind: "interlink_boss", week: String(found.run.cycle), boss: String(found.boss.id), ladder: found.ladderId });
    if (!found.ladder.one) params.set("rows", "teams");
    if (found.offset) params.set("offset", String(found.offset));
    params.set("run", found.proofId);
    params.set("link", code);
    return `${siteOrigin(env)}${BOARDS_PATH}?${params}`;
  }

  function page(status, { title, description = "", url = null, image = null, imageAlt = "", body, tabTitle = title }) {
    const meta = [
      ["name", "description", description], ["name", "theme-color", "#f5eecb"], ["name", "robots", "noindex"],
      ["property", "og:site_name", "AniiLogs"], ["property", "og:type", "website"], ["property", "og:title", title],
      ["property", "og:description", description], url && ["property", "og:url", url],
      image && ["property", "og:image", image], image && ["property", "og:image:type", "image/png"],
      image && ["property", "og:image:width", String(CARD_WIDTH)], image && ["property", "og:image:height", String(CARD_HEIGHT)],
      image && ["property", "og:image:alt", imageAlt], ["name", "twitter:card", image ? "summary_large_image" : "summary"],
      ["name", "twitter:title", title], ["name", "twitter:description", description], image && ["name", "twitter:image", image],
    ].filter(Boolean).filter(([, , value]) => value !== "");
    const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n`
      + `<title>${escapeHtml(tabTitle)}</title>\n`
      + meta.map(([attr, name, value]) => `<meta ${attr}="${escapeHtml(name)}" content="${escapeHtml(value)}">`).join("\n")
      + `\n<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1215;color:#f4f4e9;font:16px/1.5 Inter,system-ui,sans-serif}`
      + `main{max-width:32rem;padding:24px 16px}a{color:#62d9b3}p{color:#9bb5b2}</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
    return new Response(html, { status, headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "referrer-policy": "strict-origin-when-cross-origin", "x-content-type-options": "nosniff", vary: "user-agent",
    } });
  }
  function unavailable(env) {
    const boards = `${siteOrigin(env)}${BOARDS_PATH}`;
    return page(404, { title: "This run isn't available · AniiLogs", description: "This run isn't on the AniiLogs boards.",
      body: `<h1>This run isn't available</h1>\n<p>It may have left the boards.</p>\n<p><a href="${escapeHtml(boards)}">Open the leaderboards</a></p>` });
  }

  // Link-preview crawlers say who they are; anyone else is a person and goes straight to the run on the boards.
  const CRAWLER = /bot\b|bot\/|crawler|spider|facebookexternalhit|facebot|embedly|iframely|slack|discord|telegram|whatsapp|skypeuripreview|vkshare|mastodon|bluesky|cardyb|preview/iu;

  async function open(request, env, code) {
    const link = await linkOf(env, code);
    const found = link ? await placement(env, link) : null;
    if (!found) return unavailable(env);
    const target = boardsUrl(env, found, link.code);
    if (!CRAWLER.test(request.headers.get("user-agent") || "")) {
      return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store", vary: "user-agent" } });
    }
    const origin = new URL(request.url).origin;
    const { title, description, card } = describe(found);
    const { hash } = await cardKey(link.code, card);
    const image = `${origin}/api/links/${link.code}.png?p=${found.place}&v=${hash}`;
    return page(200, { title, tabTitle: `${title} · AniiLogs`, description, url: `${origin}/${link.code}`, image,
      imageAlt: `${title}: ${description}`,
      body: `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(description)}</p>\n<p><a href="${escapeHtml(target)}">Open it on AniiLogs</a></p>` });
  }

  const pngResponse = (body, immutable) => new Response(body, { status: 200, headers: {
    "content-type": "image/png", "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'",
  } });

  // The card: kept in R2 under the link, the place and a hash of everything it shows, so the same look is drawn once
  // and a new place (or a changed name or figure) draws a new one. ?p=&v= (from the preview's tags) finds a kept one
  // without reading the board.
  async function cardImage(request, env, code) {
    const link = await linkOf(env, code);
    if (!link) return json({ error: "Not found" }, 404);
    const params = new URL(request.url).searchParams;
    const asked = /^\d{1,6}$/u.test(params.get("p") || "") && /^[0-9a-f]{16}$/u.test(params.get("v") || "")
      ? `placement-cards/${link.code}/${params.get("p")}-${params.get("v")}.png` : null;
    const store = env.EVIDENCE || null;
    if (asked && store) {
      const kept = await store.get(asked);
      if (kept) return pngResponse(kept.body, true);
    }
    const found = await placement(env, link);
    if (!found) return json({ error: "This run isn't available." }, 404);
    const { card } = describe(found);
    const { key } = await cardKey(link.code, card);
    if (store && key !== asked) {
      const kept = await store.get(key);
      if (kept) return pngResponse(kept.body, false);
    }
    const png = await drawCard(card);
    if (store) {
      const put = store.put(key, png, { httpMetadata: { contentType: "image/png" } });
      if (env.waitUntil) env.waitUntil(put.catch((error) => console.error("Could not keep a placement card", error)));
      else await put;
    }
    return pngResponse(png, key === asked);
  }

  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  }

  // POST /api/links { run, ladder, player? }: the placement's link. The same placement (any copy of the run) gives the
  // code it already has; a new one is only made for a run on the board, so there can't be more links than board rows.
  async function create(request, env) {
    if (!browserWriteAllowed(request, env)) return json({ error: "Cross-origin request denied." }, 403);
    let body;
    try {
      body = await readJsonBody(request, 1024);
    } catch (error) {
      return json({ error: error.message }, error instanceof RangeError ? 413 : 400);
    }
    const ladderId = String(body?.ladder || "");
    const ladder = PLACEMENT_LADDERS[ladderId];
    const submissionId = String(body?.run || "");
    const player = ladder?.one ? String(body?.player || "").trim().toLowerCase().slice(0, 40) : "";
    if (!ladder || !RUN_ID.test(submissionId) || (ladder.one && !player)) {
      return json({ error: "Send run (a board run's id), ladder and, on a one-player ladder, player." }, 400);
    }
    const origin = new URL(request.url).origin;
    const answer = (code) => json({ code, url: `${origin}/${code}` });
    const run = await runOf(env, submissionId);
    if (!run) return json({ error: "This run isn't on a board." }, 404);
    const copies = [...run.copies].slice(0, 50);
    const existing = await env.DB.prepare(
      `SELECT code FROM placement_links WHERE ladder = ? AND player = ? AND submission_id IN (${copies.map(() => "?").join(", ")})
       ORDER BY created_at ASC, code ASC LIMIT 1`,
    ).bind(ladderId, player, ...copies).first();
    if (existing) return answer(existing.code);
    const found = await placement(env, { submissionId, ladder: ladderId, player });
    if (!found) return json({ error: "This run isn't on a board." }, 404);
    const now = Math.floor(Date.now() / 1000);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const code = newCode();
      try {
        await env.DB.prepare("INSERT OR IGNORE INTO placement_links (code, submission_id, ladder, player, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(code, submissionId, ladderId, player, now).run();
      } catch (error) {
        console.error("Could not store a placement link", error);
        return json({ error: "Links are unavailable right now." }, 503);
      }
      // ours, or the one a call at the same moment made for this placement; none: the code was taken, try another
      const stored = await env.DB.prepare("SELECT code FROM placement_links WHERE submission_id = ? AND ladder = ? AND player = ?")
        .bind(submissionId, ladderId, player).first();
      if (stored) return answer(stored.code);
    }
    return json({ error: "Links are unavailable right now." }, 503);
  }

  return { create, open, cardImage };
}
