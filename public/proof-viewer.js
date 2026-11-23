// The run's proof viewer, shared by the leaderboards and My runs: every picture of a run in its own tab (the result
// screen, Battle Data, Holo-Battle Sim's Gizmo screen, the Party screen; for staff, the fight's pictures together in
// one Fight tab), a menu best's picture beside its run's, and
// what each player went in with, under a line saying which fight it is. window.AniilogsProof: open(submissionId, check, menuId, options), button(...), checkBadge,
// partyPanel, allowDelete({ any, onDeleted }). options (the profile's trophies): shot, the picture to open on ("battle"), and note, a line over the
// pictures (Battle Data shows the whole party: the note says whose row the trophy is). options.tab "comments": open on
// the run's Comments tab (comments.js; also when the viewer already shows that run). options.link { run, ladder, player?,
// code?, realPlayers? } (the boards): a button copying a link to that place, and the Solo / Duo / Trio tag.
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";
  function sessionToken() {
    try { return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || ""); } catch { return ""; }
  }
  async function apiFetch(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = sessionToken();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${API_URL}${path}`, { ...options, credentials: "omit", headers });
  }
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) if (child !== null && child !== undefined) node.append(child);
    return node;
  }
  function number(value) {
    return value === null || value === undefined ? "—" : Number(value).toLocaleString();
  }
  // The run check's badge (shadow mode: nothing is held either way). Verified: copies of the run agree, or its pictures
  // do; Pending: its check hasn't run yet. A run that waits for staff shows nothing.
  const CHECK_BADGES = Object.freeze({
    verified: { text: "✓", label: "Verified", title: "Verified: another player's copy of the run or its pictures confirm it" },
    pending: { text: "i", label: "Pending", title: "Pending: its check hasn't run yet" },
    invalid: { text: "✕", label: "Invalid", title: "Invalid" },
  });
  function checkBadge(check) {
    const badge = CHECK_BADGES[check];
    return badge ? el("span", { class: `lb-check is-${check}`, title: badge.title, "aria-label": badge.label, text: badge.text }) : null;
  }
  // A picture icon next to a name when the run has proof pictures, for anyone: a click (or tap) opens them (the
  // result screen, Battle Data, Holo-Battle Sim's Gizmo screen), one per tab. Never on hover.
  const proofImages = new Map();                       // submission id|shot -> object URL, loaded once per page
  // shot: "summary" (the result screen), "battle" (Battle Data), "gizmo1"... (Holo-Battle Sim's Gizmo screen, a view
  // per part of its list) or "party" (the Party screen the run started from)
  async function proofImage(submissionId, shot = "summary") {
    const key = `${submissionId}|${shot}`;
    if (!proofImages.has(key)) {
      proofImages.set(key, (async () => {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}/evidence${shot === "summary" ? "" : `?shot=${shot}`}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return URL.createObjectURL(await response.blob());
      })().catch((error) => { proofImages.delete(key); throw error; }));
    }
    return proofImages.get(key);
  }
  // Which pictures a run has, in the order they were on screen, with each player's team and the run's buffs (the
  // API's ?shot=list)
  const proofLists = new Map();
  function proofDetails(submissionId) {
    if (!proofLists.has(submissionId)) {
      proofLists.set(submissionId, (async () => {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}/evidence?shot=list`);
        if (response.status === 404) return { shots: [], missing: true };    // no such run, or no pictures left
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const details = await response.json();
        return { ...details, shots: Array.isArray(details.shots) && details.shots.length ? details.shots : ["summary"] };
      // a run that isn't there (a link to a deleted run): no pictures; an older API: the two it always had
      })().catch((error) => ({ shots: String(error?.message) === "HTTP 404" ? [] : ["summary", "battle"] })));
    }
    return proofLists.get(submissionId);
  }

  // What each player went in with (the Party screen when the battle started) and the run's buffs: a row per player -
  // the name, their main Aniimo in its own chip (level and CP beside it), the rest of their team and, when the API sent
  // it (?shot=list), their Average DPS off the Battle Data card ("Not captured" when no card is surely theirs); under it
  // the team's DPS and the buffs. On a phone each row stacks.
  function partyPanel(details) {
    const facts = (m) => [Number.isInteger(m.aniimoLevel) ? `Lv ${m.aniimoLevel}` : "", Number.isInteger(m.cp) ? `CP ${number(m.cp)}` : ""]
      .filter(Boolean).join(" · ");
    // a renamed Aniimo: its species (read from the Party picture's portrait), then the player's own name for it
    const nick = (m) => (m.nickname ? `“${m.nickname}”` : "");
    const aniimo = (m) => [m.aniimo, nick(m), facts(m)].filter(Boolean).join(" ");
    // a player only the Battle Data cards had (the API's lineupWithCards) has no Party details; one whose name the site
    // leaves out shows as "Player"
    const players = (details.lineup || []).filter((p) => p.name || p.aniimo || p.unnamed);
    const buffs = details.buffs || [];
    const teamDps = Number.isFinite(details.teamDps) && details.teamDps > 0 ? details.teamDps : null;
    if (!players.length && !buffs.length) return null;
    // the Avg DPS column only when the API says (an older API, or a board row's lineup, has none: the row's table shows it)
    const dps = players.some((p) => Object.hasOwn(p, "avgDps"));
    const cell = (label, ...children) => el("div", { class: "lb-party-cell", "data-label": label }, el("span", { class: "lb-party-value" }, ...children));
    const summary = [
      teamDps ? el("span", { class: "lb-party-sum" }, el("span", { class: "lb-party-sum-label", text: "Team avg DPS" }), ` ${number(teamDps)}`) : null,
      buffs.length ? el("span", { class: "lb-party-sum lb-party-buffs" }, el("span", { class: "lb-party-sum-label", text: "Buffs" }),
        ` ${buffs.map((b) => `${b.name}${b.level ? ` Lv ${b.level}` : ""}`).join(" · ")}`) : null,
    ].filter(Boolean);
    return el("div", { class: "lb-proof-party" },
      players.length ? el("div", { class: `lb-party-grid${dps ? " has-dps" : ""}`, role: "table", "aria-label": "What each player went in with" },
        el("div", { class: "lb-party-row lb-party-head", role: "row" },
          ["Player", "Main Aniimo", "With", ...(dps ? ["Avg DPS"] : [])].map((text) => el("span", { role: "columnheader", text }))),
        players.map((p) => {
          const team = (p.team || []).filter((m) => m.aniimo && m.aniimo !== p.aniimo).map(aniimo);
          const level = facts(p);
          return el("div", { class: "lb-party-row", role: "row" },
            cell("Player", el("span", { class: "lb-party-name", text: p.name || (p.unnamed ? "Player" : "—") }), p.ai ? el("span", { class: "lb-ai", text: "AI" }) : null),
            cell("Main Aniimo", p.aniimo ? el("span", { class: "lb-party-lead" }, el("span", { class: "lb-party-lead-name", text: p.aniimo }),
              p.nickname ? el("span", { class: "lb-party-lead-nick", text: nick(p), title: "The player's own name for this Aniimo" }) : null,
              level ? el("span", { class: "lb-party-lead-facts", text: level }) : null) : el("span", { class: "lb-party-none", text: "—" })),
            cell("With", el("span", { class: "lb-party-team", text: team.length ? team.join(", ") : "—" })),
            dps ? cell("Avg DPS", Number.isFinite(p.avgDps) && p.avgDps > 0 ? el("span", { class: "lb-party-dps", text: number(p.avgDps) })
              : el("span", { class: "lb-party-none", text: "Not captured", title: "No Battle Data card for this player came with the run" })) : null);
        })) : null,
      summary.length ? el("p", { class: "lb-party-summary" }, summary) : null);
  }
  // The line over the pictures: which fight the run is (the API's fight), so a picture is never shown without it.
  // Interlink: the boss, its level, the week, stars, score and time; Holo-Battle Sim: the training, its difficulty and
  // time; Egg Heist: the difficulty or rank and its score, rank points or escape.
  const FIGHT_MODES = Object.freeze({ interlink: "Interlink", sim: "Holo-Battle Sim", eggheist: "Egg Heist" });
  function fightLine(fight) {
    const chip = FIGHT_MODES[fight?.mode];
    if (!chip) return null;
    const day = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const seconds = (value) => `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
    const has = (value) => value !== undefined && value !== null;
    const facts = [];
    if (fight.mode === "interlink") {
      if (fight.week?.start && fight.week?.end) facts.push(`Week of ${day(fight.week.start)} – ${day(fight.week.end)}`);
      if (has(fight.stars)) facts.push(`${number(fight.stars)} ${fight.stars === 1 ? "star" : "stars"}`);
      if (has(fight.score)) facts.push(number(fight.score));
    } else if (fight.mode === "sim") {
      if (fight.difficulty) facts.push(fight.difficulty);
    } else if (fight.kind === "eggheist_season") {
      if (has(fight.points)) facts.push(`${number(fight.points)} rank points`);
    } else {
      if (has(fight.score)) facts.push(`${number(fight.score)} pts`);
      if (typeof fight.escaped === "boolean") facts.push(fight.escaped ? "Escaped" : "Failed");
    }
    if (has(fight.time)) facts.push(seconds(fight.time));
    const title = fight.title || (fight.mode === "eggheist" ? (fight.kind === "eggheist_season" ? "Season rank" : "Match") : "");
    return el("p", { class: "lb-proof-fight" }, el("span", { class: "lb-proof-mode", text: chip }),
      title ? el("strong", { text: title }) : null,
      fight.mode === "interlink" && Number.isInteger(fight.level) ? el("span", { text: `Lv ${fight.level}` }) : null,
      ...facts.map((fact) => el("span", { class: "lb-proof-fact", text: fact })));
  }
  function shotLabel(shot, shots) {
    if (shot === "battle") return "Battle Data";
    if (shot === "party") return "Party";
    if (shot.startsWith("gizmo")) return shots.filter((s) => s.startsWith("gizmo")).length > 1 ? `Gizmos ${shot.slice(5)}` : "Gizmos";
    return "Summary";
  }
  // A run's tabs from its ?shot=list: a tab per picture, and the fight's pictures ("fight1"...) and its fight log
  // (fightLog) together in one "Fight" tab after the others (staff only: the API lists them for staff alone)
  // Holo-Battle Sim's Gizmo screen comes as several looks down one scrolling list ("gizmo1"...): they share ONE tab and
  // are shown merged into one tall picture of the whole list (mergeGizmos); a single look stays a plain picture.
  function listPictures(id, list, label) {
    const fights = list.shots.filter((shot) => /^fight\d+$/u.test(shot));
    const times = new Map((Array.isArray(list.fightShots) ? list.fightShots : [])
      .filter((item) => Number.isInteger(item?.n) && Number.isFinite(item?.t)).map((item) => [item.n, item.t]));
    const gizmos = list.shots.filter((shot) => /^gizmo\d+$/u.test(shot));
    const merged = gizmos.length > 1 ? gizmos : [];
    return [
      ...list.shots.filter((shot) => !fights.includes(shot) && (!merged.includes(shot) || shot === merged[0]))
        .map((shot) => (shot === merged[0] ? { id, shot: "gizmos", label: "Gizmos", gizmos: merged } : { id, shot, label: label(shot) })),
      ...(fights.length || list.fightLog || list.record ? [{ id, shot: "fight",
        label: fights.length || list.fightLog || list.record?.pictures?.some((p) => /^fight\d+$/u.test(p?.shot)) ? "Fight" : "Proof file",
        fight: fights.map((shot) => ({ shot, t: times.get(Number(shot.slice(5))) })),
        log: list.fightLog || null, record: list.record || null }] : []),
    ];
  }
  // The Gizmo looks merged into one picture of the whole list. The list scrolls between fixed parts (the title and
  // tabs above, the button prompts below, the categories on the left), so each look's list band is lined up with the
  // one before by its text's edges (the blurred background behind them doesn't move with the list), then every row of
  // the list is taken from the look where it sits furthest from the band's faded top and bottom. Null when the looks
  // don't line up surely (any pair): the viewer then shows them one under another, as they are.
  const GIZMO_BAND = Object.freeze({ top: 0.095, bottom: 0.915, left: 0.21, matchLeft: 0.3, matchRight: 0.97 });
  const GIZMO_SURE = 0.6;                // a pair lines up when its text edges differ by under 60% of their strength
  const mergedGizmos = new Map();        // submission id -> Promise of an object URL, or null
  async function loadBitmap(url) {
    const blob = await (await fetch(url)).blob();
    return createImageBitmap(blob);
  }
  function edgeRows(bitmap, scale, x0f, x1f, top, rows) {
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, w, h);
    const x0 = Math.round(w * x0f);
    const x1 = Math.round(w * x1f);
    const y0 = Math.round(top * scale);
    const n = Math.round(rows * scale);
    const data = ctx.getImageData(x0, y0, x1 - x0, n).data;
    const cols = x1 - x0 - 1;
    const out = new Float32Array(n * cols);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const a = (y * (cols + 1) + x) * 4;
        const b = a + 4;
        out[y * cols + x] = Math.abs((data[a] + data[a + 1] + data[a + 2]) - (data[b] + data[b + 1] + data[b + 2])) / 3;
      }
    }
    return { rows: n, cols, data: out };
  }
  function pairScore(a, b, d) {
    let diff = 0;
    let sum = 0;
    const span = (a.rows - d) * a.cols;
    const from = d * a.cols;
    for (let i = 0; i < span; i += 1) {
      const p = a.data[from + i];
      const q = b.data[i];
      diff += Math.abs(p - q);
      sum += p + q;
    }
    return span ? diff / (sum / 2 + 1e-3) : Infinity;
  }
  // the scroll (in band rows at full size) from look a to look b, or null when no line-up is sure
  function gizmoScroll(fineA, fineB, coarseA, coarseB, scale) {
    let best = { score: Infinity, d: 0 };
    for (let d = 0; d < Math.floor(coarseA.rows * 0.75); d += 1) {
      const score = pairScore(coarseA, coarseB, d);
      if (score < best.score) best = { score, d };
    }
    let fine = { score: Infinity, d: 0 };
    const centre = Math.round(best.d / scale);
    for (let d = Math.max(0, centre - 6); d <= Math.min(Math.floor(fineA.rows * 0.75), centre + 6); d += 1) {
      const score = pairScore(fineA, fineB, d);
      if (score < fine.score) fine = { score, d };
    }
    return fine.score < GIZMO_SURE ? fine.d : null;
  }
  function mergeGizmos(id, shots) {
    if (!mergedGizmos.has(id)) {
      mergedGizmos.set(id, (async () => {
        const looks = await Promise.all(shots.map(async (shot) => loadBitmap(await proofImage(id, shot))));
        const { width: W, height: H } = looks[0];
        if (looks.some((look) => look.width !== W || look.height !== H)) return null;
        const top = Math.round(H * GIZMO_BAND.top);
        const bottom = Math.round(H * GIZMO_BAND.bottom);
        const rows = bottom - top;
        const left = Math.round(W * GIZMO_BAND.left);
        // edges on the text column only, full size (in a band 1080 px pictures' rows) and a quarter for the first search
        const fine = looks.map((look) => edgeRows(look, 1, GIZMO_BAND.matchLeft, GIZMO_BAND.matchRight, top, rows));
        const coarse = looks.map((look) => edgeRows(look, 0.25, GIZMO_BAND.matchLeft, GIZMO_BAND.matchRight, top, rows));
        const at = [0];
        for (let i = 1; i < looks.length; i += 1) {
          const d = gizmoScroll(fine[i - 1], fine[i], coarse[i - 1], coarse[i], 0.25);
          if (d === null) return null;
          at.push(at[i - 1] + d);
        }
        const length = at[at.length - 1] + rows;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = top + length + (H - bottom);
        const ctx = canvas.getContext("2d");
        // above the list and its categories: the first look as it was; below the categories, their own background
        ctx.drawImage(looks[0], 0, 0, W, bottom, 0, 0, W, bottom);
        const strip = document.createElement("canvas");
        strip.width = 1;
        strip.height = 1;
        const sctx = strip.getContext("2d", { willReadFrequently: true });
        sctx.drawImage(looks[0], 0, bottom - 2, left, 1, 0, 0, 1, 1);
        const [r, g, b] = sctx.getImageData(0, 0, 1, 1).data;
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(0, bottom, left, canvas.height - bottom);
        // each list row from the look where it is most central
        const pick = (y) => {
          let best = 0;
          let room = -Infinity;
          at.forEach((start, i) => {
            if (y < start || y >= start + rows) return;
            const m = Math.min(y - start, start + rows - 1 - y);
            if (m > room) { room = m; best = i; }
          });
          return best;
        };
        for (let y = 0; y < length;) {
          const i = pick(y);
          let end = y + 1;
          while (end < length && pick(end) === i) end += 1;
          const from = y - at[i];
          ctx.drawImage(looks[i], left, top + from, W - left, end - y, left, top + y, W - left, end - y);
          y = end;
        }
        ctx.drawImage(looks[looks.length - 1], 0, bottom, W, H - bottom, 0, top + length, W, H - bottom);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
        return blob ? URL.createObjectURL(blob) : null;
      })().catch(() => null));
    }
    return mergedGizmos.get(id);
  }
  async function gizmoPanel(body, picture, still) {
    body.replaceChildren(el("p", { class: "lb-empty", text: "Putting the gizmo list together…" }));
    const separate = async () => {
      const urls = await Promise.all(picture.gizmos.map((shot) => proofImage(picture.id, shot).catch(() => null)));
      if (!still()) return;
      body.replaceChildren(el("div", { class: "lb-gizmo-scroll" },
        urls.filter(Boolean).map((url, i) => el("img", { class: "lb-gizmo-merged", src: url, alt: `Gizmo screen, look ${i + 1} of ${urls.length}` }))));
    };
    const url = await mergeGizmos(picture.id, picture.gizmos);
    if (!still()) return;
    if (!url) { await separate(); return; }
    const toggle = el("button", { type: "button", class: "lb-gizmo-toggle", text: `Show the ${picture.gizmos.length} pictures as taken`, onclick: separate });
    body.replaceChildren(el("div", { class: "lb-gizmo-scroll" },
      el("img", { class: "lb-gizmo-merged", src: url, alt: "This run's Gizmo screen, the whole list" })), toggle);
  }

  // The proof file (staff only), once a run's whole screens and fight pictures were removed after 7 days (or when a
  // better run replaced them): what they showed, in their place, and a download of the whole file
  const PICTURE_NAMES = Object.freeze({ full: "Whole result screen", battle_full: "Whole Battle Data screen" });
  function proofRecordPanel(id, record) {
    const has = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
    const size = (bytes) => (has(bytes) ? `${number(Math.max(1, Math.round(bytes / 1024)))} KB` : "");
    const when = has(record.keptAt) ? new Date(record.keptAt * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
    const why = record.why === "replaced by a better run" ? "when a better run replaced them" : "after 7 days";
    const pictures = (record.pictures || []).filter((p) => p && typeof p.shot === "string").map((p) => {
      const fight = /^fight(\d+)$/u.exec(p.shot);
      const name = fight ? `Fight picture ${fight[1]}${has(p.t) ? ` · ${clock(p.t)}` : ""}` : PICTURE_NAMES[p.shot] || p.shot;
      return el("li", { text: [name, size(p.bytes)].filter(Boolean).join(" · ") });
    });
    const result = record.reading?.result && typeof record.reading.result === "object" ? record.reading.result : null;
    const read = result ? [has(result.score) ? `${number(result.score)} pts` : "", has(result.stars) ? `${number(result.stars)} stars` : "",
      typeof result.time === "string" ? result.time : ""].filter(Boolean).join(" · ") : "";
    const download = el("button", { type: "button", class: "lb-fight-download", text: "Download the proof file", onclick: async () => {
      download.disabled = true;
      try {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(id)}/evidence?shot=record`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const url = URL.createObjectURL(await response.blob());
        const link = el("a", { href: url, download: `proof-${id}.json` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch {
        window.alert("Could not download the proof file.");
      } finally {
        download.disabled = false;
      }
    } });
    return el("section", { class: "lb-fight-log lb-proof-record", "aria-label": "Proof file" },
      el("h3", { class: "lb-fight-log-title", text: "Proof file" }),
      el("p", { class: "lb-fight-log-note", text: `This run's pictures were removed ${why}${when ? ` (${when})` : ""}. What they showed is kept here: the run's numbers, the second reading, when each fight picture was taken, the fight log's figures${record.fightLog?.kept ? " and the fight log itself" : ""}.` }),
      pictures.length ? el("ul", { class: "lb-proof-record-list" }, pictures) : null,
      read ? el("p", { class: "lb-fight-log-note", text: `Second reading of the result screen: ${read}${record.check ? ` (${record.check})` : ""}.` }) : null,
      download);
  }
  const COUNT_WORDS = ["One", "Two", "Three", "Four", "Five", "Six"];
  function clock(seconds) {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }
  // The fight log under the pictures (or alone): its main figures, a line when the app's last log was left out, and a
  // download of the file (the same signed-in fetch: the API gives it to staff only)
  const LOG_NOTES = Object.freeze({ "too large": "it was too large", "not gzip": "it wasn't a gzip file", "no rows": "it had no rows",
    "too few rows": "it had fewer than 20 usable rows", unreadable: "it couldn't be read" });
  function fightLogPanel(id, log) {
    const stats = log?.stats && typeof log.stats === "object" ? log.stats : null;
    const has = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
    const clockRate = !stats ? "" : has(stats.clockRate)
      ? `${number(stats.clockRate)}× real time${has(stats.clockSpanS) && stats.clockSpanS < 60 ? ` (read over ${number(stats.clockSpanS)} s only)` : ""}` : "Not read";
    const figures = stats ? [
      ["Length", has(stats.wallS) ? clock(stats.wallS) : "—"],
      ["Team damage", number(stats.damage)],
      ["Team DPS", number(stats.dps)],
      ["Hits a second", number(stats.hitsPerS)],
      ["Median hit", number(stats.hitMedian)],
      ["90th-percentile hit", number(stats.hitP90)],
      ["Game clock against real time", clockRate],
      ["Breaks a minute", number(stats.breaksPerMin)],
      ["Time broken", has(stats.brokenSharePct) ? `${number(stats.brokenSharePct)}%` : "—"],
    ] : [];
    const why = LOG_NOTES[log?.note] || (log?.note ? `it was left out (${log.note})` : "");
    const note = why ? (stats ? `The app's latest fight log for this run was left out: ${why}. The figures are from the one before.`
      : `The app sent a fight log for this run, but it was left out: ${why}.`) : "";
    const download = stats && log.download !== false ? el("button", { type: "button", class: "lb-fight-download", text: "Download the fight log", onclick: async () => {
      download.disabled = true;
      try {
        const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(id)}/evidence?shot=fightlog`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const url = URL.createObjectURL(await response.blob());
        const link = el("a", { href: url, download: `fight-${id}.csv.gz` });
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch {
        window.alert("Could not download the fight log.");
      } finally {
        download.disabled = false;
      }
    } }) : null;
    return el("section", { class: "lb-fight-log", "aria-label": "Fight log" },
      el("h3", { class: "lb-fight-log-title", text: "Fight log" }),
      figures.length ? el("dl", { class: "lb-fight-log-figures" }, figures.map(([label, value]) => el("div", { class: "lb-fight-log-figure" },
        el("dt", { text: label }), el("dd", { text: value })))) : null,
      note ? el("p", { class: "lb-fight-log-note", text: note }) : null,
      download);
  }
  // The Fight tab: a line saying what the pictures are, then each picture full width with its time into the fight in a
  // corner; a click (or Enter) opens one full size, with a way back to all of them. Never on hover. The fight log under them.
  function fightPanel(body, picture, current) {
    const shots = picture.fight;
    const log = () => [picture.record ? proofRecordPanel(picture.id, picture.record) : null,
      picture.log ? fightLogPanel(picture.id, picture.log) : null];
    const count = COUNT_WORDS[shots.length - 1] || String(shots.length);
    const note = shots.length === 1
      ? "One moment of the fight, taken right after the biggest hit of that part. The numbers are this player's own hits. Click the picture to open it full size."
      : `${count} moments of the fight, each taken right after the biggest hit of that part. The numbers are this player's own hits. Click a picture to open it full size.`;
    const alt = (i) => `Fight picture ${i + 1} of ${shots.length}`;
    const load = (img, shot) => proofImage(picture.id, shot.shot)
      .then((url) => { if (current()) img.src = url; })
      .catch(() => { img.replaceWith(el("span", { class: "lb-empty", text: "This picture couldn't be loaded." })); });
    const strip = (focus = -1) => {
      const buttons = shots.map((shot, i) => {
        const img = el("img", { alt: alt(i) });
        load(img, shot);
        return el("button", { type: "button", class: "lb-fight-shot", title: "Open full size", onclick: () => single(i) },
          img, Number.isFinite(shot.t) ? el("span", { class: "lb-fight-time", text: clock(shot.t) }) : null);
      });
      body.replaceChildren(el("div", { class: "lb-fight" }, shots.length ? el("p", { class: "lb-fight-note", text: note }) : null,
        shots.length ? el("div", { class: "lb-fight-strip" }, buttons) : null, log()));
      buttons[focus]?.focus();
    };
    const single = (i) => {
      const img = el("img", { class: "lb-proof-image", alt: alt(i) });
      load(img, shots[i]);
      const back = el("button", { type: "button", class: "lb-fight-back", text: "← Back to all", onclick: () => strip(i) });
      const time = Number.isFinite(shots[i].t) ? el("span", { class: "lb-fight-at", text: `${alt(i)} · ${clock(shots[i].t)}` })
        : el("span", { class: "lb-fight-at", text: alt(i) });
      body.replaceChildren(el("div", { class: "lb-fight" }, el("p", { class: "lb-fight-bar" }, back, time), img));
      back.focus();
    };
    strip();
  }
  function proofButton(submissionId, check = null, menuId = null, options = {}) {
    if (!submissionId) return null;
    const button = el("button", { type: "button", class: "lb-proof", title: "This run's screenshots",
      "aria-label": "View this run's screenshots", onclick: () => openProof(submissionId, check, menuId, options) });
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9.6l3.3-3.3a1 1 0 0 1 1.4 0l2.8 2.8 4.3-4.3a1 1 0 0 1 1.4 0L19 11.6V6H5Zm3.5 1.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z"/></svg>';
    // opened by a click only (the owner, 21 Nov: a viewer that pops up when the pointer passes over the icon is in the way)
    return button;
  }
  // Deleting a run from the viewer: only the owner and administrators (the API's canDeleteRuns; the page passes it to
  // allowDelete). The API checks again.
  let deleter = null;
  function allowDelete(config) { deleter = config || null; }
  function deleteAction(dialog, submissionId, details) {
    if (!deleter?.any) return;
    const what = details.menu ? "menu best" : "run";
    const button = el("button", { type: "button", class: "danger-button", text: `Delete this ${what}`, onclick: async () => {
      if (!window.confirm(`Delete this ${what} from the leaderboards, with its pictures? This can't be undone.`)) return;
      button.disabled = true;
      const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(submissionId)}`, { method: "DELETE" }).catch(() => null);
      if (!response?.ok) { button.disabled = false; window.alert(`Could not delete this ${what}.`); return; }
      proofLists.delete(submissionId);
      dialog.close();
      deleter?.onDeleted?.(submissionId);
    } });
    dialog.append(el("div", { class: "lb-proof-actions" }, button));
  }
  // Storing a Party picture's reading (POST .../leads, staff only): the cards it is sure of. Not staff: the first 403
  // ends it for the page.
  let leadsRefused = false;
  async function saveLeads(runId, found) {
    const portraits = window.AniilogsPartyPortraits;
    if (leadsRefused || !portraits?.sureCards) return false;
    const response = await apiFetch(`/leaderboard/submissions/${encodeURIComponent(runId)}/leads`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: portraits.sureCards(found) }) }).catch(() => null);
    if (response?.status === 401 || response?.status === 403) leadsRefused = true;
    if (response?.ok) proofLists.delete(runId);
    return Boolean(response?.ok);
  }
  // A staff pass over the runs whose Party picture isn't read yet (GET /api/admin/lead-reads), from the browser's
  // console: AniilogsProof.readLeads({ max }). Reads and stores one run at a time; answers { read, stored, left }.
  async function readLeads({ max = 50 } = {}) {
    const portraits = window.AniilogsPartyPortraits;
    if (!portraits?.readPicture) throw new Error("party-portraits.js isn't on this page.");
    let read = 0;
    let stored = 0;
    let left = 0;
    while (read < max) {
      const response = await apiFetch(`/admin/lead-reads?limit=${Math.min(20, max - read)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = await response.json();
      left = page.left;
      if (!page.runs?.length) break;
      for (const run of page.runs) {
        read += 1;
        const reading = await portraits.readPicture(async () => (await fetch(await proofImage(run.submissionId, "party"))).blob(), run.mode)
          .catch(() => ({ found: [] }));
        if (!reading) throw new Error("The Party heads pack isn't available.");
        // a picture that can't be read is stored as read with nothing sure, so the pass moves on
        if (await saveLeads(run.submissionId, reading?.found || [])) stored += 1;
        else if (leadsRefused) throw new Error("Only staff can store readings.");
      }
    }
    return { read, stored, left: Math.max(0, left - stored) };
  }
  let proofOpenFor = null;                             // the run the viewer shows (a late picture of another is dropped)
  let openComments = null;                             // its Comments tab (comments.js), and what picks that tab
  let showCommentsTab = null;
  async function openProof(submissionId, check = null, menuId = null, options = {}) {
    let dialog = document.querySelector("dialog.lb-proof-dialog");
    if (!dialog) {
      dialog = el("dialog", { class: "lb-proof-dialog" },
        el("form", { method: "dialog" }, el("button", { type: "submit", class: "lb-proof-close", "aria-label": "Close", text: "×" })),
        el("div", { class: "lb-proof-body" }));
      dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });   // click outside
      document.body.append(dialog);
    }
    const body = dialog.querySelector(".lb-proof-body");
    let tabs = dialog.querySelector(".lb-proof-tabs");
    if (!tabs) { tabs = el("div", { class: "lb-proof-tabs", role: "tablist" }); dialog.insertBefore(tabs, body); }
    if (dialog.open && proofOpenFor === submissionId) {
      if (options?.tab === "comments") showCommentsTab?.();
      return;
    }
    proofOpenFor = submissionId;
    openComments?.detach();
    openComments = null;
    showCommentsTab = null;
    tabs.replaceChildren();
    dialog.querySelector(".lb-proof-party")?.remove();
    dialog.querySelector(".lb-proof-note")?.remove();
    dialog.querySelector(".lb-proof-fight")?.remove();
    dialog.querySelector(".lb-proof-actions")?.remove();
    if (options?.note) dialog.insertBefore(el("p", { class: "lb-proof-note", text: String(options.note) }), body);
    body.replaceChildren(el("p", { class: "lb-empty", text: "Loading the screenshots…" }));
    if (!dialog.open) dialog.showModal();             // it stays until a click outside it, × or Esc
    const details = await proofDetails(submissionId);
    if (proofOpenFor !== submissionId) return;
    // A best sent from the game's menu: its menu picture first, then the pictures of the player's best run of that boss
    // and week (the menu proof is added to them, it doesn't replace them).
    const run = details.menu && details.runProof ? await proofDetails(details.runProof) : null;
    // A run whose score a menu best matched: the menu picture goes with the run's (the board's menuProofId)
    const menu = !details.menu && menuId ? await proofDetails(menuId).catch(() => null) : null;
    if (proofOpenFor !== submissionId) return;
    // which fight it is, over the pictures (a menu best's own facts, else its run's)
    dialog.querySelector(".lb-proof-fight")?.remove();
    const fight = fightLine(details.fight || run?.fight);
    if (fight) dialog.insertBefore(fight, dialog.querySelector(".lb-proof-note") || body);
    const pictures = [
      ...(menu?.shots?.includes("summary") ? [{ id: menuId, shot: "summary", label: "Menu" }] : []),
      ...listPictures(submissionId, details, (shot) => (details.menu && shot === "summary" ? "Menu" : shotLabel(shot, details.shots))),
      ...(run ? listPictures(details.runProof, run, (shot) => shotLabel(shot, run.shots)) : []),
    ];
    dialog.querySelector(".lb-proof-party")?.remove();
    const shown = details.lineup?.length || details.buffs?.length || !run ? details : run;
    const party = partyPanel(shown);
    if (party) dialog.append(party);
    // Each lead as the Party picture shows it (party-portraits.js): a renamed Aniimo's card prints the nickname, so
    // the name the app read says nothing about the species. The table is drawn again once the picture is read.
    const shownId = shown === details ? submissionId : details.runProof;
    const portraits = window.AniilogsPartyPortraits;
    if (party && portraits?.lineupFromPicture && shown.lineup?.length && shown.shots?.includes("party")) {
      const mode = (shown.fight || details.fight)?.mode === "eggheist" ? "eggheist" : "interlink";
      // a staff member's reading is stored, so the boards, search and the board row show it too (the API takes it from
      // staff only; anyone else's viewer never sends it, and one 403 stops it trying for the page)
      const store = shown.leadsRead || !sessionToken() || leadsRefused ? null : (found) => { saveLeads(shownId, found); };
      portraits.lineupFromPicture(shownId, shown.lineup, async () => (await fetch(await proofImage(shownId, "party"))).blob(), mode, store)
        .then((lineup) => {
          if (proofOpenFor !== submissionId || lineup === shown.lineup) return;
          const fresh = partyPanel({ ...shown, lineup });
          const old = dialog.querySelector(".lb-proof-party");
          if (fresh && old) old.replaceWith(fresh);
        });
    }
    deleteAction(dialog, submissionId, details);
    // the run's comments (comments.js): a tab after the pictures; a menu best's go to its run
    const commentsRun = details.menu ? details.runProof : submissionId;
    const comments = commentsRun && window.AniilogsComments ? window.AniilogsComments.mount(commentsRun) : null;
    dialog.classList.remove("is-comments");
    const showComments = () => {
      for (const tab of tabs.querySelectorAll("[data-proof-shot]")) tab.setAttribute("aria-selected", "false");
      comments.tab.setAttribute("aria-selected", "true");
      dialog.classList.add("is-comments");
      return comments.show(body);
    };
    openComments = comments;
    showCommentsTab = comments ? showComments : null;
    // a tab for each picture
    const show = async (index) => {
      const picture = pictures[index];
      dialog.classList.remove("is-comments");
      comments?.tab.setAttribute("aria-selected", "false");
      if (!picture) { body.replaceChildren(el("p", { class: "lb-empty", text: "This run isn't available." })); return; }
      for (const tab of tabs.querySelectorAll("[data-proof-shot]")) tab.setAttribute("aria-selected", String(Number(tab.dataset.proofShot) === index));
      if (picture.fight) { fightPanel(body, picture, () => proofOpenFor === submissionId); return; }
      if (picture.gizmos) { gizmoPanel(body, picture, () => proofOpenFor === submissionId); return; }
      body.replaceChildren(el("p", { class: "lb-empty", text: "Loading the screenshot…" }));
      try {
        const url = await proofImage(picture.id, picture.shot);
        if (proofOpenFor !== submissionId) return;
        body.replaceChildren(el("img", { class: "lb-proof-image", src: url, alt: `This run's ${picture.label} screen` }));
      } catch {
        body.replaceChildren(el("p", { class: "lb-empty", text: `This run has no ${picture.label} screenshot.` }));
      }
    };
    tabs.append(...pictures.map((picture, index) => el("button", { type: "button", role: "tab", "data-proof-shot": String(index),
      onclick: () => show(index) }, picture.label, picture.fight?.length ? el("span", { class: "lb-fight-count", text: String(picture.fight.length) }) : null)));
    if (comments) {
      comments.tab.addEventListener("click", showComments);
      tabs.append(comments.tab);
    }
    // the run check's badge beside the tabs
    const badge = checkBadge(check);
    if (badge) tabs.append(badge);
    // options.link (the boards): the run's Solo / Duo / Trio tag and a link to its place (leaderboard/share.js)
    const share = options?.link && window.AniilogsShare;
    const shareTag = share ? share.tag(options.link.realPlayers) : null;
    const shareButton = share && details.shots.length ? share.button(options.link) : null;
    if (shareTag || shareButton) tabs.append(el("span", { class: "lb-proof-share" }, shareTag, shareButton));
    // options.tab "comments" opens on the Comments tab (a link to a run's comments); a run with no pictures left too
    if (comments && (options?.tab === "comments" || (!pictures.length && await comments.ready))) {
      if (proofOpenFor === submissionId) await showComments();
      return;
    }
    // the picture asked for (a trophy read off Battle Data opens on it), else the first
    const start = options?.shot ? pictures.findIndex((picture) => picture.id === submissionId && picture.shot === options.shot) : -1;
    await show(Math.max(0, start));
  }
  window.AniilogsProof = Object.freeze({ open: openProof, button: proofButton, checkBadge, partyPanel, allowDelete, readLeads });
})();
