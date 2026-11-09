const loginLinks = [...document.querySelectorAll("[data-login]")];
const accountButton = document.querySelector("[data-account]");
const profileLink = document.querySelector("[data-profile-link]");
const accountMenu = document.querySelector("[data-account-menu]");
const logoutButton = document.querySelector("[data-logout]");
const deleteAccountButton = document.querySelector("[data-delete-account]");
const settingsShortcut = document.querySelector("[data-settings-shortcut]");
const status = document.querySelector("[data-auth-status]");
const profileEditor = document.querySelector("[data-profile-editor]");
const profileDisplayName = document.querySelector("[data-profile-display-name]");
const profileBio = document.querySelector("[data-profile-bio]");
const profileSaveButton = document.querySelector("[data-profile-save]");
const profileStatus = document.querySelector("[data-profile-status]");
const profileOverview = document.querySelector("[data-profile-overview]");
const PROFILE_VIEW = new URLSearchParams(window.location.search).get("view") === "profile"
  || /^(?:[A-Za-z0-9]{8,24}|\d{1,24})$/u.test(new URLSearchParams(window.location.search).get("profile") || "");
const profilePublic = document.querySelector("[data-profile-public]");
const profilePublicRow = document.querySelector("[data-profile-public-row]");
const profilePublicLink = document.querySelector("[data-profile-public-link]");
const profileFindable = document.querySelector("[data-profile-findable]");
const profileFindableRow = document.querySelector("[data-profile-findable-row]");
const profileShowPresence = document.querySelector("[data-profile-presence]");
const profilePresenceRow = document.querySelector("[data-profile-presence-row]");
const profileSearchRow = document.querySelector("[data-profile-search-row]");
const profileListedInSearch = document.querySelector("[data-profile-search]");
// Show me by: the in-game name (default) or the Discord name, everywhere the site names this player
const profileNameShown = document.querySelector("[data-profile-name-shown]");
const profileNameShownRow = document.querySelector("[data-profile-name-shown-row]");
// a player's name as they chose to be shown (site-sidebar.js draws the Discord logo for a Discord name)
function shownName(text, nameSource) {
  return window.AniiSite?.playerName(text, nameSource) || document.createTextNode(String(text || ""));
}
// /?view=profile is the profile page: your own profile (or a sign-in prompt), with a search for anyone else's.
// /?profile=<id> shows someone's public profile (read-only) in the same view; <id> can be a character's game UID
// (the profile of the account that linked it, or "This profile is private").
const PUBLIC_PROFILE_ID = /^(?:[A-Za-z0-9]{8,24}|\d{1,24})$/u.test(new URLSearchParams(window.location.search).get("profile") || "")
  ? new URLSearchParams(window.location.search).get("profile")
  : "";
// true once the server says the profile at ?profile=<id> is the viewer's own
let ownAtLink = false;
// ?profile=<id>&as=visitor: the owner's "View public profile": the page asks for it signed out, so it's exactly what
// anyone else sees (the account stays signed in for everything else)
const VISITOR_PREVIEW = Boolean(PUBLIC_PROFILE_ID) && new URLSearchParams(window.location.search).get("as") === "visitor";
const siteConfig = window.ANIILOGS_CONFIG || {};
const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
const AUTH_SESSION_STORAGE_KEY = "aniilogs:auth:session:v1";

function authSessionToken() {
  try {
    return String(window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

function clearAuthSession() {
  try {
    window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
  } catch {
    // Storage denial already leaves this page signed out.
  }
}

async function apiFetch(path, options = {}) {
  if (!API_URL) throw new Error("AniiLogs account API is not configured.");
  const headers = new Headers(options.headers || {});
  const token = authSessionToken();
  const asVisitor = VISITOR_PREVIEW && path.startsWith("/profiles/");
  if (token && !asVisitor) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...options, credentials: "omit", headers });
}

function signInUrl() {
  const returnUrl = new URL(window.location.href);
  returnUrl.hash = "";
  return `${API_URL}/auth/discord/start?return_to=${encodeURIComponent(returnUrl.toString())}`;
}

function configureLoginLinks() {
  for (const link of loginLinks) {
    link.href = signInUrl();
    link.classList.remove("is-disabled");
    link.removeAttribute("aria-disabled");
    if (link.classList.contains("secondary-button")) {
      link.textContent = "Continue with Discord";
      continue;
    }
    const label = link.querySelector("span");
    if (label) label.textContent = "Sign in";
    link.setAttribute("aria-label", "Sign in with Discord");
  }
}

async function consumeAuthHandoff() {
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
  const handoff = fragment.get("aniilogs_auth") || "";
  if (!handoff) return;
  fragment.delete("aniilogs_auth");
  const cleanUrl = new URL(window.location.href);
  cleanUrl.hash = fragment.toString();
  window.history.replaceState(null, "", cleanUrl);
  const response = await apiFetch("/auth/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handoff }),
  });
  if (!response.ok) throw new Error(`Discord sign-in handoff returned ${response.status}`);
  const result = await response.json();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(String(result.token || ""))) {
    throw new Error("Discord sign-in handoff did not return a valid session.");
  }
  window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, result.token);
}

function showSignedOut(message = "") {
  for (const link of loginLinks) link.hidden = false;
  accountMenu.hidden = true;
  accountButton.hidden = true;
  profileLink.hidden = true;
  logoutButton.hidden = true;
  deleteAccountButton.hidden = true;
  settingsShortcut.hidden = false;
  profileEditor.hidden = true;
  profileEditor.reset();
  profileStatus.textContent = "";
  profileOverview.hidden = !PUBLIC_PROFILE_ID && !PROFILE_VIEW;
  if (PROFILE_VIEW) {
    document.querySelector("[data-profile-signin]").hidden = Boolean(PUBLIC_PROFILE_ID);
    if (!PUBLIC_PROFILE_ID) {
      profileOverview.querySelector(".profile-overview-header").hidden = true;
      profileOverview.querySelector(".profile-overview-grid").hidden = true;
    }
  }
  status.textContent = message;
}

function showSignedIn(account) {
  for (const link of loginLinks) link.hidden = true;
  const name = account.displayName || account.globalName || account.username;
  accountMenu.hidden = false;
  accountButton.textContent = name;
  accountButton.title = `Signed in as @${account.username}`;
  accountButton.hidden = false;
  profileLink.hidden = false;
  logoutButton.hidden = false;
  deleteAccountButton.hidden = false;
  settingsShortcut.hidden = true;
  status.textContent = "";
  profilePublicRow.hidden = false;
  profileFindableRow.hidden = false;
  profilePresenceRow.hidden = false;
  profileSearchRow.hidden = false;
  profileNameShownRow.hidden = false;
  void loadPrivateProfile(name);
  if (PROFILE_VIEW) {
    document.querySelector("[data-profile-signin]").hidden = true;
    // on someone else's profile (your own link shows your own: showAsOwner)
    document.querySelector("[data-profile-back]").hidden = !PUBLIC_PROFILE_ID || ownAtLink;
    document.querySelector("[data-profile-edit]").hidden = Boolean(PUBLIC_PROFILE_ID) && !ownAtLink;
  }
  if (PROFILE_VIEW && !PUBLIC_PROFILE_ID) void loadProfileOverview();   // your profile: on the Profiles page only
}

// Who can see the profile: Public (everything), Custom (the parts ticked) or Private (only its owner)
const profileParts = document.querySelector("[data-profile-parts]");
// My runs has its own switch, private by default; it only reaches anyone while the profile itself is public
const profileRunsPublic = document.querySelector("[data-profile-runs-public]");
function syncVisibilityControls() {
  const shown = profilePublic.value !== "private";
  profileFindable.disabled = !shown;
  profileListedInSearch.disabled = !shown;
  profileRunsPublic.disabled = !shown;
  profileParts.hidden = profilePublic.value !== "custom";
}
profilePublic.addEventListener("change", syncVisibilityControls);

function showVisibility(profile) {
  profilePublic.value = profile.visibility || (profile.isPublic ? "public" : "private");
  for (const box of profileParts.querySelectorAll("input[type=checkbox]")) box.checked = (profile.publicParts || []).includes(box.value);
  profileRunsPublic.value = profile.runsPublic ? "public" : "private";
  syncVisibilityControls();
  profileFindable.checked = Boolean(profile.findableByName);
  profileListedInSearch.checked = profile.listedInSearch !== false;
  profileShowPresence.checked = profile.showPresence !== false;
  profileNameShown.value = profile.nameShown === "discord" ? "discord" : "game";
  profileStatus.textContent = { public: "Public · anyone with the link can see it", custom: "Custom · anyone with the link sees the parts you picked",
    private: "Private · visible only to you" }[profilePublic.value];
  profilePublicLink.hidden = !(profile.isPublic && profile.publicId);
  if (profile.isPublic && profile.publicId) {
    // the main character's game UID when there is one (the profile id link keeps working)
    const id = profile.profileUid || profile.publicId;
    const link = element("a", "", `${window.location.origin}/?profile=${id}`);
    link.href = `/?profile=${id}`;
    profilePublicLink.replaceChildren("Your profile link: ", link);
  }
}

async function loadPrivateProfile(fallbackName = "") {
  profileEditor.hidden = false;
  profileStatus.textContent = "Loading your profile…";
  try {
    const response = await apiFetch("/profile");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const profile = payload.profile || {};
    profileDisplayName.value = String(profile.displayName || fallbackName).slice(0, 80);
    profileBio.value = String(profile.bio || "").slice(0, 500);
    showVisibility(profile);
  } catch {
    profileEditor.hidden = true;
    profileStatus.textContent = "";
    status.textContent = "Signed in, but your profile could not be loaded.";
  }
}

// ---------------------------------------------------------------- profile overview
// The owner's records gathered in one place: board standing from the desktop app and collection progress from the map.
const numberFormat = new Intl.NumberFormat("en");

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Every row on the profile that opens (an Interlink week or boss, a Battle History run): a chevron at the start of its
// summary that turns down when it is open (styles.css), the open row marked with an accent bar, and aria-expanded kept
// in step for screen readers.
const CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function disclosure(details) {
  const summary = details.querySelector(":scope > summary");
  if (!summary) return details;
  details.classList.add("disclosure");
  const chevron = element("span", "disclosure-chevron");
  chevron.innerHTML = CHEVRON;
  summary.prepend(chevron);
  const sync = () => summary.setAttribute("aria-expanded", String(details.open));
  details.addEventListener("toggle", sync);
  sync();
  return details;
}

// An Aniimo's name on the profile is itself the link to its Aniilog page (no separate icon): subtle, it keeps the
// text's colour and underlines on hover or focus. The run keeps the name read off the Party screen; the Aniilog finds
// the Aniimo by it (/aniimo-link.js).
function aniimoNameLink(name) {
  const href = name ? window.AniilogsAniimoLink?.url(name) : "";
  if (!href) return document.createTextNode(name || "");
  const link = element("a", "aniimo-name", name);
  link.href = href;
  link.title = `Open ${name} in the Aniilog`;
  return link;
}

function overviewBody(panel) {
  return profileOverview.querySelector(`[data-overview-panel="${panel}"] [data-overview-body]`);
}

function clockTime(seconds) {
  const total = Math.round(Number(seconds) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function boardLink(entry, kind) {
  const params = new URLSearchParams({ mode: kind.split("_")[0], kind });
  if (entry.boss?.id && (kind === "interlink_run" || kind === "interlink_best")) params.set("boss", entry.boss.id);
  if (entry.cycle && kind === "eggheist_season") params.set("cycle", entry.cycle);
  const link = element("a", "profile-position", `#${entry.position}`);
  link.href = `/leaderboard/?${params}`;
  link.title = `Position ${entry.position} of ${entry.players} players · open the board`;
  return link;
}

// One row per board entry: label, position link to the board, and a detail line.
function standingRow(label, entry, kind, detail, withStars = false) {
  const row = element("li");
  row.append(element("span", "", label), boardLink(entry, kind));
  const extra = [`of ${numberFormat.format(entry.players)}`, ...detail.filter(Boolean)];
  if (entry.character) extra.push(entry.character);
  const small = element("small", "", extra.join(" · "));
  if (withStars && entry.stars != null) {                   // challenge-rating stars on that boss
    const stars = element("span", "profile-stars");
    stars.append(starIcon(), element("span", "", numberFormat.format(entry.stars)));
    small.append(" · ", stars);
  }
  row.append(small);
  return row;
}

function rowList(rows) {
  const list = element("ul", "profile-rows");
  list.append(...rows);
  return list;
}

function standingList(heading, rows) {
  const fragment = document.createDocumentFragment();
  if (rows.length) fragment.append(element("h4", "", heading), rowList(rows));
  return fragment;
}

// The game's challenge-rating star (drawn, not the game's art).
function starIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "profile-star"); svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = '<circle cx="12" cy="12" r="11" fill="#f2c230" stroke="#c98e12" stroke-width="1.5"/>'
    + '<path d="M12 5.2l1.95 4.1 4.5.55-3.3 3.1.85 4.45L12 15.2l-4 2.2.85-4.45-3.3-3.1 4.5-.55z" fill="#7a4b00"/>';
  return svg;
}

// The Holo-Battle Interlink card: the current season part on top (Season 1.1: only its own weeks count, the owner,
// 7 Nov), then its weeks as a tree, newest first - a week opens to its bosses (this player's best of each, as the
// boards count it), a boss to every run of it that week (when the runs can be seen: always for the owner, for a visitor
// when My runs is public) - and at the bottom the earlier parts' totals, each linking to their best runs in My runs.
function interlinkRunsHref(split, label, publicId) {
  const next = new URLSearchParams(window.location.search);
  for (const key of ["history", "split", "best", "label"]) next.delete(key);
  if (!publicId) next.set("view", "profile");
  next.set("history", "1");
  next.set("split", String(split));
  next.set("best", "1");
  next.set("label", label);
  return `/?${next}`;
}
function interlinkStars(value) {
  const stars = element("span", "profile-stars");
  stars.append(starIcon(), element("span", "", numberFormat.format(value || 0)));
  return stars;
}
// "Boss Killed 1:40", "Early Exit 2:31", "Timed Out" (as the boards say it)
function interlinkEnding(boss) {
  const time = boss.runTimeS ?? boss.clearTimeS;
  if (boss.outcome === "unconfirmed") return time != null ? clockTime(time) : "";
  const ending = boss.outcome === "ended-early" ? "Early Exit" : boss.outcome === "cleared" ? "Boss Killed"
    : boss.outcome === "time-up" ? "Timed Out" : boss.clearTimeS != null ? "Boss Killed" : time != null ? "Timed Out" : "Menu best";
  return time != null && ending !== "Timed Out" && ending !== "Menu best" ? `${ending} ${clockTime(time)}` : ending;
}
function interlinkPartLine(part, { current = false, publicId = null, runsOpen = false } = {}) {
  const line = element(current ? "div" : "li", current ? "interlink-part is-current" : "interlink-part");
  const name = element(current ? "strong" : "span", "interlink-part-name", part.label);
  const figures = element("span", "interlink-part-figures");
  figures.append(element("strong", "", `${numberFormat.format(part.total)} pts`), " ", interlinkStars(part.stars),
    element("small", "", ` · ${part.weeksPlayed} week${part.weeksPlayed === 1 ? "" : "s"}`));
  line.append(name, figures);
  if (part.rank) {
    const rank = element("a", "profile-position", `#${part.rank}`);
    rank.href = `/leaderboard/?mode=interlink&kind=interlink_ladder&season=${part.season}&split=${part.split}`;
    rank.title = `Position ${part.rank} of ${part.players} players in ${part.label} · open its ladder`;
    const where = element("span", "interlink-part-rank");
    where.append(rank, element("small", "", ` of ${numberFormat.format(part.players)}`));
    line.append(where);
  }
  if (!current && runsOpen) {
    const link = element("a", "interlink-part-runs", "Best runs");
    link.href = interlinkRunsHref(part.split, part.label, publicId);
    link.title = `${publicId ? "This player's" : "Your"} best run of each boss and week in ${part.label}`;
    line.append(link);
  }
  return line;
}
// a boss's runs that week, fetched when its line is opened
async function fillInterlinkBossRuns(holder, week, boss, publicId) {
  holder.replaceChildren(element("p", "history-empty", "Loading…"));
  try {
    const path = publicId ? `/profiles/${encodeURIComponent(publicId)}/history` : "/profile/history";
    const params = new URLSearchParams({ page: "1", limit: "50", mode: "interlink", boss: boss.id, cycle: week.cycle });
    const response = await apiFetch(`${path}?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { runs = [], total = runs.length } = await response.json();
    if (!runs.length) { holder.replaceChildren(element("p", "history-empty", "No runs of this boss kept for this week.")); return; }
    const list = element("ul", "interlink-runs");
    for (const run of runs) {
      const item = element("li", run.submissionId === boss.runId ? "is-best" : "");
      const when = run.playedAt ? new Date(run.playedAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      const text = element("span", "interlink-run-text");
      text.append(element("small", "", when), element("span", "", runResult(run)));
      const chips = element("span", "history-chips");
      chips.append(...historyChips(run));
      if (run.submissionId === boss.runId) chips.prepend(element("span", "history-chip is-best", "Counts"));
      const proof = runProofCell(run);
      if (proof.textContent === "None") proof.textContent = "No pictures";      // no column heading here to say what
      item.append(text, chips, proof);
      list.append(item);
    }
    holder.replaceChildren(list);
    if (total > runs.length) {
      const more = element("a", "history-see-all", `All ${numberFormat.format(total)} runs`);
      const next = new URLSearchParams(window.location.search);
      if (!publicId) next.set("view", "profile");
      next.set("history", "1");
      more.href = `/?${next}`;
      holder.append(more);
    }
  } catch {
    holder.replaceChildren(element("p", "history-empty", "These runs couldn't be loaded right now."));
  }
}
function interlinkWeek(week, { publicId, runsOpen }) {
  const item = element("li", "interlink-week");
  const details = element("details");
  details.open = week.current;
  const summary = element("summary");
  const label = week.start ? `Week of ${shortDate(week.start)}${week.end ? ` – ${shortDate(week.end)}` : ""}` : `Week ${week.cycle}`;
  const title = element("span", "interlink-week-name", label);
  if (week.current) title.append(element("span", "history-chip is-current", "This week"));
  const figures = element("span", "interlink-week-figures");
  figures.append(element("strong", "", `${numberFormat.format(week.total)} pts`), " ", interlinkStars(week.stars));
  summary.append(title, figures);
  details.append(summary);
  disclosure(details);
  const bosses = element("ul", "interlink-bosses");
  for (const boss of week.bosses) {
    const row = element("li", "interlink-boss");
    const line = element("span", "interlink-boss-line");
    const name = element("span", "interlink-boss-name");
    name.append(element("strong", "", boss.name || "Boss"), element("small", "", interlinkEnding(boss)));
    const score = element("span", "interlink-boss-figures");
    score.append(element("strong", "", `${numberFormat.format(boss.score || 0)} pts`), " ", interlinkStars(boss.stars));
    line.append(name, score);
    const proof = boss.proofId && window.AniilogsProof ? window.AniilogsProof.button(boss.proofId, null, boss.menuProofId || null) : null;
    if (runsOpen) {
      // the boss opens to its runs that week
      const inner = element("details");
      const head = element("summary");
      head.append(line);
      if (proof) { proof.addEventListener("click", (event) => event.preventDefault()); head.append(proof); }
      const holder = element("div", "interlink-boss-runs");
      inner.append(head, holder);
      disclosure(inner);
      inner.addEventListener("toggle", () => {
        if (!inner.open || inner.dataset.filled) return;
        inner.dataset.filled = "1";
        void fillInterlinkBossRuns(holder, week, boss, publicId);
      });
      row.append(inner);
    } else {
      const plain = element("div", "interlink-boss-plain");
      plain.append(line);
      if (proof) plain.append(proof);
      row.append(plain);
    }
    bosses.append(row);
  }
  details.append(bosses);
  item.append(details);
  return item;
}
function renderInterlink(boards, { publicId = null, runsOpen = false } = {}) {
  const body = overviewBody("interlink");
  // an API from before the season parts: its season standing alone
  const season = boards.interlinkSeason;
  if (boards.interlinkParts === undefined && season?.total) {
    body.replaceChildren(interlinkPartLine({ label: `Season ${season.season}`, season: season.season, split: "", total: season.total, stars: season.stars,
      weeksPlayed: season.weeks, rank: season.rank, players: season.players }, { current: true }));
    return;
  }
  const parts = boards.interlinkParts;
  if (!parts || (!parts.current?.weeksPlayed && !parts.previous?.length)) {
    body.replaceChildren(element("p", "", "No Interlink scores yet. The desktop app sends them after each boss fight."));
    return;
  }
  const nodes = [];
  if (parts.current) {
    nodes.push(interlinkPartLine(parts.current, { current: true, publicId, runsOpen }));
    if (parts.current.weeks?.length) {
      const tree = element("ol", "interlink-weeks");
      tree.append(...parts.current.weeks.map((week) => interlinkWeek(week, { publicId, runsOpen })));
      nodes.push(tree);
    } else nodes.push(element("p", "history-empty", `No runs in ${parts.current.label} yet.`));
  }
  if (parts.previous?.length) {
    nodes.push(element("h4", "", "Earlier seasons"));
    const list = element("ul", "interlink-parts");
    list.append(...parts.previous.map((part) => interlinkPartLine(part, { publicId, runsOpen })));
    nodes.push(list);
  }
  body.replaceChildren(...nodes);
}

function renderSim(boards) {
  const body = overviewBody("sim");
  const rows = (boards.sim_run || []).map((entry) => standingRow(
    `Best clear ${clockTime(entry.clearTimeS)}`,
    entry,
    "sim_run",
    [entry.floors != null ? `${entry.floors} floors` : "", entry.partySize ? `party of ${entry.partySize}` : ""],
  ));
  if (!rows.length) body.replaceChildren(element("p", "", "No Holo-Battle Sim clears yet."));
  else body.replaceChildren(standingList("Fastest clear", rows));
}

// The game's badge for an Egg Heist rank (1 Rookie Egg Hunter ... 7 Egg Emperor), from the reviewed content release.
function eggRankIcon(tier) {
  const base = String(siteConfig.contentBaseUrl || "").replace(/\/+$/u, "");
  if (!base || !Number.isInteger(tier) || tier < 1 || tier > 7) return null;
  const icon = element("img", "profile-rank-icon");
  icon.src = `${base}/assets/eggheist/rank-${tier}-small.png`;
  icon.alt = "";
  icon.loading = "lazy";
  icon.addEventListener("error", () => icon.remove());       // no picture yet: the rank name is still there
  return icon;
}

// The game's Profile screen numbers (Collection Progress), read by the aLogs meter from the player's own Profile, with
// the game's icons for them from the reviewed content release.
const GAME_STATS = [
  ["aniimoPoint", "Aniimo Point", "aniimo-point"],
  ["sparklingAniimo", "Sparkling Aniimo", "sparkling-aniimo"],
  ["stylePoints", "Style Points", "style-points"],
  ["prismanaAniimo", "Prismana Aniimo", "prismana-aniimo"],
];

function renderGameStats(stats) {
  const list = profileOverview.querySelector("[data-overview-stats]");
  const title = profileOverview.querySelector("[data-overview-stats-title]");
  const base = String(siteConfig.contentBaseUrl || "").replace(/\/+$/u, "");
  const items = GAME_STATS.filter(([key]) => Number.isInteger(stats?.[key])).map(([key, label, file]) => {
    const item = element("li", "profile-game-stat");
    if (base) {
      const icon = element("img", "profile-game-stat-icon");
      icon.src = `${base}/assets/profile/${file}.png`;
      icon.alt = "";
      icon.loading = "lazy";
      icon.addEventListener("error", () => icon.remove());   // no picture yet: the label is still there
      item.append(icon);
    }
    item.append(element("span", "profile-game-stat-label", label), element("strong", "", numberFormat.format(stats[key])));
    return item;
  });
  list.replaceChildren(...items);
  list.hidden = !items.length;
  title.hidden = !items.length;
  title.textContent = "In game";
  if (items.length && stats.seenAt) list.title = `From the game's Profile screen, ${new Date(stats.seenAt * 1000).toLocaleDateString()}`;
}

function renderEggHeist(boards) {
  const body = overviewBody("eggheist");
  const rows = (boards.eggheist_season || []).map((entry) => {
    const rank = entry.seasonRank?.name || (entry.seasonRank ? `Tier ${entry.seasonRank.tier}` : "Unranked");
    const emperor = entry.seasonRank?.tier === 7;
    const progress = entry.seasonProgress || {};
    const row = standingRow(
      entry.cycle ? `${entry.cycle} · ${rank}` : rank,
      entry,
      "eggheist_season",
      [
        // below Egg Emperor: Rank Points toward the next rank (Rank Info's "1337/2370"); at Egg Emperor: the eggs
        entry.score != null && !emperor
          ? `${numberFormat.format(entry.score)}${progress.nextRankAt ? ` / ${numberFormat.format(progress.nextRankAt)}` : ""} rank points`
          : "",
        emperor && entry.stars != null ? `${numberFormat.format(entry.stars)} eggs` : "",
        !emperor && progress.lastGain != null ? `${progress.lastGain < 0 ? "" : "+"}${numberFormat.format(progress.lastGain)} last match` : "",
      ],
    );
    const icon = eggRankIcon(entry.seasonRank?.tier);
    if (icon) {
      const label = row.firstElementChild;
      label.classList.add("profile-rank");
      label.prepend(icon);
    }
    if (!emperor && entry.score != null && progress.nextRankAt) {
      const meter = element("span", "profile-meter");
      const fill = element("i");
      fill.style.width = `${Math.min(100, Math.round((entry.score / progress.nextRankAt) * 100))}%`;
      meter.setAttribute("aria-hidden", "true");
      meter.append(fill);
      row.append(meter);
    }
    return row;
  });
  if (!rows.length) body.replaceChildren(element("p", "", "No Egg Heist season rank yet."));
  else body.replaceChildren(standingList("Season standing", rows));
}

// The Trophies card: each personal best the boards rank (best score, fastest clear, best Avg DPS...), as a tile with its
// figure, where it was set, its place on that ladder (linking to the board) and its proof. A figure read off Battle
// Data opens the viewer on that screen, which shows the whole party: the note says whose row it is. Hidden with none.
const TROPHY_MODES = [["interlink", "Holo-Battle Interlink"], ["sim", "Holo-Battle Sim"], ["eggheist", "Egg Heist"]];
function trophyValue(trophy) {
  if (trophy.unit === "time") return clockTime(trophy.value);
  if (trophy.unit === "rank") return String(trophy.value || "Unranked");
  return numberFormat.format(Number(trophy.value) || 0);
}
function trophyContext(trophy) {
  const context = trophy.context || {};
  const week = context.week?.start ? `Week of ${shortDate(context.week.start)}` : context.week?.cycle ? `Week ${context.week.cycle}` : "";
  const season = context.season ? `Season ${context.season}` : "";
  const points = trophy.points != null ? `${numberFormat.format(trophy.points)} rank points` : trophy.mode === "eggheist" && trophy.stars != null ? `${numberFormat.format(trophy.stars)} eggs` : "";
  const played = trophy.playedAt && !week ? shortDate(trophy.playedAt) : "";
  return [context.boss?.name, week, context.difficulty, season, points, played].filter(Boolean).join(" · ");
}
// The tile's mark: what kind of figure it is (a cup for a score, a clock for a time, a bolt for a number, a medal for
// a rank), in its mode's colour (styles.css)
const TROPHY_ICONS = {
  score: '<path d="M7 4h10v3a5 5 0 0 1-10 0V4Z"/><path d="M7 5H4v1.5A3.5 3.5 0 0 0 7.5 10M17 5h3v1.5A3.5 3.5 0 0 1 16.5 10M12 12v4M8.5 20h7M9.5 16h5l.5 4h-6l.5-4Z"/>',
  time: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M10 3h4"/>',
  number: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z"/>',
  rank: '<circle cx="12" cy="14.5" r="5.5"/><path d="m8.5 9.5-3-6.5h4l2.5 5M15.5 9.5l3-6.5h-4l-1.4 3"/><path d="m12 12 .9 1.8 2 .3-1.45 1.4.35 2-1.8-.95-1.8.95.35-2-1.45-1.4 2-.3L12 12Z"/>',
};
function trophyIcon(unit) {
  const icon = element("span", "trophy-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false">${TROPHY_ICONS[unit] || TROPHY_ICONS.number}</svg>`;
  return icon;
}
// what the card shows and, for its owner, which trophies visitors don't see (saved to /api/profile/trophies)
const trophyCard = { list: [], hidden: new Set(), owner: false, editing: false, draft: null, saving: false, message: "" };
function trophyTile(trophy) {
  const editing = trophyCard.editing;
  const hidden = (editing ? trophyCard.draft : trophyCard.hidden).has(trophy.id);
  const tile = element("li", `trophy-tile is-${trophy.mode}${hidden ? " is-hidden" : ""}`);
  tile.dataset.trophy = trophy.id;
  const top = element("div", "trophy-top");
  top.append(trophyIcon(trophy.unit), element("span", "trophy-title", trophy.label));
  if (editing) {
    // the owner's switch: shown to visitors or not
    const toggle = element("label", "trophy-toggle");
    const box = element("input");
    box.type = "checkbox";
    box.checked = !hidden;
    box.dataset.trophyKey = trophy.id;
    box.addEventListener("change", () => {
      if (box.checked) trophyCard.draft.delete(trophy.id); else trophyCard.draft.add(trophy.id);
      tile.classList.toggle("is-hidden", !box.checked);
      toggle.lastChild.textContent = box.checked ? "Shown" : "Hidden";
      renderTrophyToolbar();
    });
    toggle.append(box, element("span", "", hidden ? "Hidden" : "Shown"));
    toggle.title = `Show "${trophy.label}" to visitors`;
    top.append(toggle);
  }
  tile.append(top);
  const value = element("strong", "trophy-value", trophyValue(trophy));
  if (trophy.unit === "rank") {
    const icon = eggRankIcon(trophy.rank?.tier);
    if (icon) value.prepend(icon);
  }
  if (trophy.mode === "interlink" && trophy.stars != null) value.append(interlinkStars(trophy.stars));
  tile.append(value);
  const context = trophyContext(trophy);
  if (context) tile.append(element("small", "trophy-context", context));
  const foot = element("div", "trophy-foot");
  const place = trophy.placement;
  if (place?.position) {
    const medal = place.position <= 3 ? ` is-top${place.position}` : "";
    const link = element("a", `trophy-place${medal}`, `#${place.position}`);
    link.append(element("small", "", ` of ${numberFormat.format(place.players)}`));
    link.href = `/leaderboard/?${new URLSearchParams(trophy.board || {})}`;
    link.title = `Position ${place.position} of ${place.players} players on this ladder · open the board`;
    foot.append(link);
  }
  const proof = trophy.proof;
  if (proof?.id && window.AniilogsProof) {
    const slice = proof.slice;
    const note = slice ? `Battle Data shows the whole party: this trophy is ${slice.player ? `${slice.player}'s` : "this player's"} ${slice.figure}, ${trophyValue(trophy)}.` : "";
    const button = window.AniilogsProof.button(proof.id, proof.check || null, proof.menuId || null, { shot: proof.shot, note });
    button.classList.add("trophy-proof");
    button.append(element("span", "", "Proof"));
    foot.append(button);
  }
  if (foot.childElementCount) tile.append(foot);
  return tile;
}
// the owner's bar over the tiles: how many visitors see, and Choose trophies (Save / Cancel / Show all while choosing)
function renderTrophyToolbar() {
  const panel = profileOverview.querySelector('[data-overview-panel="trophies"]');
  let bar = panel.querySelector(".trophy-toolbar");
  if (!trophyCard.owner) { bar?.remove(); return; }
  if (!bar) {
    bar = element("div", "trophy-toolbar");
    panel.querySelector("h3").after(bar);
  }
  const set = trophyCard.editing ? trophyCard.draft : trophyCard.hidden;
  const total = trophyCard.list.length;
  const shown = trophyCard.list.filter((trophy) => !set.has(trophy.id)).length;
  const summary = element("span", "trophy-summary", trophyCard.message
    || (trophyCard.editing ? "Tick the trophies visitors see." : shown === total ? `All ${total} shown to visitors` : `${shown} of ${total} shown to visitors`));
  summary.setAttribute("role", "status");
  const button = (label, className, onClick, extra = {}) => {
    const node = element("button", `profile-tool-button ${className}`, label);
    node.type = "button";
    node.disabled = trophyCard.saving;
    node.addEventListener("click", onClick);
    for (const [key, value] of Object.entries(extra)) node.setAttribute(key, value);
    return node;
  };
  const actions = element("span", "trophy-actions");
  if (trophyCard.editing) {
    actions.append(
      button("Show all", "is-quiet", () => { trophyCard.draft = new Set([...trophyCard.draft].filter((key) => !trophyCard.list.some((trophy) => trophy.id === key))); drawTrophies(); }),
      button("Cancel", "is-quiet", () => { trophyCard.editing = false; trophyCard.draft = null; trophyCard.message = ""; drawTrophies(); }),
      button(trophyCard.saving ? "Saving…" : "Save", "is-primary", () => void saveTrophyChoice()),
    );
  } else {
    actions.append(button("Choose trophies", "", () => {
      trophyCard.editing = true;
      trophyCard.draft = new Set(trophyCard.hidden);
      trophyCard.message = "";
      drawTrophies();
      panel.querySelector("[data-trophy-key]")?.focus();
    }, { "data-trophy-edit": "", "aria-pressed": "false" }));
  }
  bar.replaceChildren(summary, actions);
}
async function saveTrophyChoice() {
  trophyCard.saving = true;
  renderTrophyToolbar();
  try {
    const response = await apiFetch("/profile/trophies", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: [...trophyCard.draft] }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(payload.hidden)) throw new Error(payload.error || `HTTP ${response.status}`);
    trophyCard.hidden = new Set(payload.hidden);
    trophyCard.editing = false;
    trophyCard.draft = null;
    trophyCard.message = "";
  } catch {
    trophyCard.message = "Couldn't save. Nothing changed.";
  } finally {
    trophyCard.saving = false;
  }
  drawTrophies();
}
function drawTrophies() {
  const body = overviewBody("trophies");
  const { list, owner, editing } = trophyCard;
  // visitors only get the shown ones from the server; the owner sees what visitors see, or everything while choosing
  const visible = editing ? list : list.filter((trophy) => !trophyCard.hidden.has(trophy.id));
  const nodes = [];
  for (const [mode, label] of TROPHY_MODES) {
    const own = visible.filter((trophy) => trophy.mode === mode);
    if (!own.length) continue;
    const head = element("h4", `trophy-group is-${mode}`);
    head.append(element("span", "", label), element("small", "", String(own.length)));
    const grid = element("ul", "trophy-grid");
    grid.append(...own.map(trophyTile));
    nodes.push(head, grid);
  }
  if (!nodes.length && owner) nodes.push(element("p", "history-empty", "Every trophy is hidden from visitors. Choose trophies to show some again."));
  body.replaceChildren(...nodes);
  body.classList.toggle("is-choosing", editing);
  renderTrophyToolbar();
}
function renderTrophies(trophies, { owner = false, hidden = [] } = {}) {
  const panel = profileOverview.querySelector('[data-overview-panel="trophies"]');
  const list = Array.isArray(trophies) ? trophies : [];
  panel.hidden = !list.length;
  Object.assign(trophyCard, { list, owner: owner && list.length > 0, hidden: new Set(Array.isArray(hidden) ? hidden : []), editing: false, draft: null, message: "" });
  drawTrophies();
}

// Home page pictures from the reviewed content release (a missing one leaves its card's text).
for (const picture of document.querySelectorAll("img[data-content-src]")) {
  const base = String(siteConfig.contentBaseUrl || "").replace(/\/+$/u, "");
  if (!base) { picture.remove(); continue; }
  picture.addEventListener("error", () => picture.remove(), { once: true });
  picture.src = `${base}/${picture.dataset.contentSrc}${siteConfig.contentRevision ? `?v=${siteConfig.contentRevision}` : ""}`;
}

// Photos the player took in Aniimo, uploaded from the aLogs app. Each shows what the game recorded with it: when, the
// character, the Aniimo in it (linked to their Aniilog entries) and where (the map it's on).
const contentData = new Map();
function loadContentData(file) {
  const base = String(siteConfig.contentBaseUrl || "").replace(/\/+$/u, "");
  if (!base) return Promise.resolve(null);
  if (!contentData.has(file)) {
    contentData.set(file, fetch(`${base}/data/${file}`).then((response) => (response.ok ? response.json() : null)).catch(() => null));
  }
  return contentData.get(file);
}

async function photoLookups() {
  const [aniilog, maps] = await Promise.all([loadContentData("aniilog_data.json"), loadContentData("map_site_data.json")]);
  const base = String(siteConfig.contentBaseUrl || "").replace(/\/+$/u, "");
  const aniimo = new Map();
  for (const entry of Array.isArray(aniilog?.entries) ? aniilog.entries : []) {
    if (entry.form_id && entry.name) aniimo.set(String(entry.form_id), { name: entry.name, icon: entry.icon ? `${base}/${entry.icon}` : "" });
  }
  // scene -> the map it's on: the overworld's scene names the main map; other places are "map-<scene>-layer-1-level-1-..."
  const places = new Map();
  const list = maps?.maps || [];
  if (maps?.scene_id != null && list[0]) places.set(String(maps.scene_id), { id: list[0].id, label: list[0].label });
  for (const map of list) {
    const match = /^map-(\d+)-layer-1-level-1-/u.exec(map.id || "");
    if (match && !places.has(match[1])) places.set(match[1], { id: map.id, label: map.label });
  }
  return { aniimo, places };
}

async function photoImage(photo, publicView) {
  const url = `${API_URL.replace(/\/api$/u, "")}${photo.url}`;
  if (publicView) return url;
  // your own profile while it's private: the picture needs your sign-in, which an <img> can't send
  const response = await apiFetch(photo.url.replace(/^\/api/u, ""));
  return response.ok ? URL.createObjectURL(await response.blob()) : "";
}

function renderPhotos(photos, publicView = false) {
  const panel = profileOverview.querySelector('[data-overview-panel="photos"]');
  const body = overviewBody("photos");
  panel.hidden = !photos?.length;
  if (!photos?.length) { body.replaceChildren(); return; }
  const grid = element("div", "profile-photo-grid");
  const captions = [];
  for (const photo of photos) {
    const figure = element("figure", "profile-photo");
    const link = element("a");
    link.target = "_blank"; link.rel = "noopener";
    const img = element("img");
    img.alt = ""; img.loading = "lazy";
    link.append(img);
    void photoImage(photo, publicView).then((src) => { if (src) { img.src = src; link.href = src; } else figure.remove(); });
    const caption = element("figcaption");
    const when = photo.takenAt ? new Date(photo.takenAt * 1000).toLocaleDateString([], { dateStyle: "medium" }) : "";
    caption.append(element("span", "profile-photo-when", [when, photo.character].filter(Boolean).join(" · ")));
    figure.append(link, caption);
    grid.append(figure);
    captions.push([photo, caption]);
  }
  body.replaceChildren(grid);
  // the Aniimo and the place come from the site's data: added when it arrives, so the photos never wait for it
  void photoLookups().then(({ aniimo, places }) => {
    for (const [photo, caption] of captions) {
      const tags = element("span", "profile-photo-tags");
      for (const id of photo.aniimo || []) {
        const known = aniimo.get(String(id));
        if (!known) continue;
        const chip = element("a", "profile-photo-aniimo");
        chip.href = window.AniilogsAniimoLink?.url(id) || `/explorer/?aniimo=${encodeURIComponent(id)}`;
        if (known.icon) {
          const icon = element("img");
          icon.src = known.icon; icon.alt = ""; icon.loading = "lazy";
          chip.append(icon);
        }
        chip.append(known.name);
        tags.append(chip);
      }
      const place = places.get(String(photo.sceneId));
      if (place) {
        const where = element("a", "profile-photo-place", `📍 ${String(place.label).replace(/\s+[^\w\s]\s+.*$/u, "")}`);
        where.href = `/explorer/?map=${encodeURIComponent(place.id)}`;
        tags.append(where);
      }
      if (tags.childElementCount) caption.append(tags);
    }
  });
}

function progressRow(label, done, total) {
  const row = element("li");
  row.append(element("span", "", label));
  row.append(element("strong", "", total
    ? `${numberFormat.format(done)} / ${numberFormat.format(total)}`
    : numberFormat.format(done)));
  if (total) {
    const meter = element("span", "profile-meter");
    const fill = element("i");
    fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
    meter.setAttribute("aria-hidden", "true");
    meter.append(fill);
    row.append(meter);
  }
  return row;
}

function renderCollection(collection, publicView = false) {
  const { aniilog = {}, lumens = {}, pins = {} } = collection || {};
  const aniilogRows = [
    progressRow("Standard", aniilog.standard || 0, aniilog.forms),
    progressRow("Sparkling", aniilog.sparkling || 0, aniilog.forms),
  ];
  if (aniilog.specialTotal) aniilogRows.push(progressRow("Special records", aniilog.special || 0, aniilog.specialTotal));
  const lumenRow = lumens.collected != null
    ? progressRow("Lumin Amber collected", lumens.collected, lumens.total)
    : progressRow("Lumin Amber spots collected", lumens.sources || 0, lumens.sourceTotal);
  const note = element("p", "", publicView ? "Counted from the AniiLogs map checklist and desktop app. " : "Counted from your map checklist and the desktop app. ");
  const mapLink = element("a", "profile-position", "Open the map");
  mapLink.href = "/explorer/";
  note.append(mapLink);
  overviewBody("collection").replaceChildren(
    element("h4", "", "Aniilog"),
    rowList(aniilogRows),
    element("h4", "", "Lumin Amber"),
    rowList([lumenRow]),
    element("h4", "", "Map"),
    rowList([progressRow("Pins collected", pins.collected || 0, null)]),
    note,
  );
}

function setHeadTag(selector, create, attribute, value) {
  let tag = document.head.querySelector(selector);
  if (!value) { tag?.remove(); return; }
  if (!tag) { tag = document.createElement(create.tag); Object.assign(tag, create.props); document.head.append(tag); }
  tag.setAttribute(attribute, value);
}

function describeForSearch({ title = "", description = "", canonical = "", noindex = false }) {
  if (title) document.title = title;
  if (description) setHeadTag('meta[name="description"]', { tag: "meta", props: { name: "description" } }, "content", description);
  setHeadTag('link[rel="canonical"]', { tag: "link", props: { rel: "canonical" } }, "href", canonical);
  setHeadTag('meta[name="robots"]', { tag: "meta", props: { name: "robots" } }, "content", noindex ? "noindex" : "");
}

if (PROFILE_VIEW && !PUBLIC_PROFILE_ID) describeForSearch({ title: "AniiLogs — Player profiles", noindex: true });

async function loadProfileOverview(publicId = "") {
  const overviewStatus = profileOverview.querySelector("[data-overview-status]");
  profileOverview.hidden = false;
  overviewStatus.textContent = publicId ? "Loading this profile…" : "Loading your records…";
  try {
    const response = await apiFetch(publicId ? `/profiles/${encodeURIComponent(publicId)}` : "/profile/overview");
    if (response.status === 404 && publicId) {
      const isPrivate = (await response.json().catch(() => ({}))).private === true;
      for (const panel of profileOverview.querySelectorAll("[data-overview-panel]")) panel.hidden = true;
      profileOverview.querySelector("[data-overview-name]").textContent = isPrivate ? "This profile is private" : "Profile not found";
      overviewStatus.textContent = isPrivate ? "Its owner keeps this profile private." : "This profile is private or doesn't exist.";
      describeForSearch({ title: isPrivate ? "AniiLogs — Private profile" : "AniiLogs — Profile not found", noindex: true });
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const overview = await response.json();
    if (publicId && overview.own) {
      showAsOwner();
      return loadProfileOverview();
    }
    const avatar = profileOverview.querySelector("[data-overview-avatar]");
    avatar.hidden = !overview.profile?.avatarUrl;
    if (overview.profile?.avatarUrl) avatar.src = overview.profile.avatarUrl;
    profileOverview.querySelector("[data-overview-name]").replaceChildren(shownName(overview.profile?.displayName || "My profile", overview.profile?.nameSource));
    profileOverview.querySelector("[data-overview-visibility]").textContent = publicId ? "Public profile"
      : overview.profile?.visibility === "custom" ? "Custom · anyone with your link sees the parts you picked"
        : overview.profile?.isPublic ? "Public · anyone with your link can see this" : "Private · only you can see this";
    profileOverview.querySelector("[data-overview-bio]").textContent = overview.profile?.bio || "";
    if (publicId) {
      const who = overview.profile?.displayName || "Pathfinder";
      describeForSearch({
        title: `${who} — Aniimo player profile · AniiLogs`,
        description: `${who}'s Aniimo profile on AniiLogs: Holo-Battle Interlink, Holo-Battle Sim and Egg Heist leaderboard standing, characters and records.`,
        canonical: `https://aniilogs.github.io/?profile=${encodeURIComponent(publicId)}`,
        noindex: overview.profile?.listedInSearch === false,
      });
    }
    // Online (green) while they're in Aniimo with aLogs running, AFK (amber) after 20 minutes away from the game,
    // Offline (red) when the game or aLogs isn't running
    const presence = profileOverview.querySelector("[data-overview-presence]");
    const label = { online: "Online", afk: "AFK", offline: "Offline" }[overview.presence];
    presence.hidden = !label;
    presence.dataset.state = overview.presence || "";
    presence.textContent = label || "";
    const mainName = overview.main?.name;
    const characterLine = profileOverview.querySelector("[data-overview-characters]");
    characterLine.replaceChildren();
    (overview.characters || []).forEach((character, index) => {
      // name, gender mark, level (with the EXP into it, from the game's EXP card) and server, as far as the desktop
      // app has seen them
      const name = `${character.name || `UID ${character.gameUid}`}${{ female: " ♀", male: " ♂" }[character.gender] || ""}`;
      const entry = element("span", "profile-character");
      entry.append(document.createTextNode(index ? ", " : "Characters: "), document.createTextNode(name));
      if (Number.isInteger(character.level)) entry.append(document.createTextNode(` · Lv ${character.level}`));
      if (Number.isInteger(character.exp) && character.expNeeded > 0) {
        const exp = element("span", "profile-exp");
        const bar = element("span", "profile-exp-bar");
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-label", `EXP toward level ${(character.level || 0) + 1}`);
        bar.setAttribute("aria-valuemin", "0");
        bar.setAttribute("aria-valuemax", String(character.expNeeded));
        bar.setAttribute("aria-valuenow", String(character.exp));
        const fill = element("span");
        fill.style.width = `${Math.min(100, (character.exp / character.expNeeded) * 100).toFixed(1)}%`;
        bar.append(fill);
        exp.append(bar, element("span", "", `${numberFormat.format(character.exp)} / ${numberFormat.format(character.expNeeded)} EXP`));
        entry.append(exp);
      }
      if (character.server) entry.append(document.createTextNode(` · ${character.server}`));
      if (mainName && character.name === mainName) entry.append(document.createTextNode(" (main)"));
      characterLine.append(entry);
    });
    if (!characterLine.childNodes.length && !publicId) characterLine.textContent = "No game characters linked yet. The desktop app links yours when it sees you in game.";
    // Board standing follows the leaderboard gate; the server sends none while the owner can't read the boards.
    for (const panel of ["interlink", "sim", "eggheist"]) {
      profileOverview.querySelector(`[data-overview-panel="${panel}"]`).hidden = !overview.leaderboards;
    }
    if (overview.leaderboards) {
      renderInterlink(overview.leaderboards, { publicId,
        runsOpen: !publicId || (Array.isArray(overview.parts) && overview.parts.includes("history")) });
      renderSim(overview.leaderboards);
      renderEggHeist(overview.leaderboards);
    }
    // with the standing: the server sends none while that part is private or the boards are closed
    renderTrophies(overview.leaderboards ? overview.trophies : null, { owner: !publicId, hidden: overview.hiddenTrophies });
    renderGameStats(overview.gameStats);
    renderCollection(overview.collection, Boolean(publicId));
    // someone else's profile shows only its public parts (Custom); the server sends nothing for the others
    const parts = publicId && Array.isArray(overview.parts) ? overview.parts : null;
    for (const [panel, part] of [["collection", "collection"], ["history", "history"]]) {
      if (parts) profileOverview.querySelector(`[data-overview-panel="${panel}"]`).hidden = !parts.includes(part);
    }
    renderPhotos(overview.photos, Boolean(publicId));
    applyCardLayout(overview.layout);
    showProfileLink(publicId, overview.profile);
    runsArePublic = Boolean(overview.profile?.runsPublic);
    if (!parts || parts.includes("history")) showBattleHistory(publicId);
    profileOverview.querySelector("[data-profile-arrange]").hidden = Boolean(publicId);
    overviewStatus.textContent = overview.leaderboards ? "" : "Leaderboard standing appears here once leaderboards open.";
    // The section was hidden when the page loaded, so a #my-profile link could not land on it then.
    if (!PROFILE_VIEW && window.location.hash === "#my-profile") profileOverview.scrollIntoView({ behavior: "instant" });
  } catch {
    overviewStatus.textContent = publicId ? "This profile could not be loaded right now." : "Your records could not be loaded right now.";
  }
}

profileEditor.addEventListener("submit", async (event) => {
  event.preventDefault();
  const displayName = profileDisplayName.value.trim();
  const bio = profileBio.value.trim();
  if (!displayName) {
    profileStatus.textContent = "Enter a display name.";
    profileDisplayName.focus();
    return;
  }
  profileSaveButton.disabled = true;
  profileStatus.textContent = "Saving…";
  // Visibility is only sent when the public switch is offered (developer preview); otherwise it stays as it is.
  const visibility = profilePublicRow.hidden ? {} : {
    visibility: profilePublic.value,
    ...(profilePublic.value === "custom" ? { publicParts: [...profileParts.querySelectorAll("input:checked")].map((box) => box.value) } : {}),
    findableByName: profileFindable.checked, showPresence: profileShowPresence.checked, listedInSearch: profileListedInSearch.checked,
    runsPublic: profileRunsPublic.value === "public",
  };
  try {
    const response = await apiFetch("/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, bio, ...visibility, ...(profileNameShownRow.hidden ? {} : { nameShown: profileNameShown.value }) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.profile) throw new Error(payload.error || `HTTP ${response.status}`);
    profileDisplayName.value = payload.profile.displayName;
    profileBio.value = payload.profile.bio || "";
    accountButton.textContent = payload.profile.displayName;
    showVisibility(payload.profile);
    profileStatus.textContent = `Saved · ${profileStatus.textContent}`;
    if (!profileOverview.hidden && (!PUBLIC_PROFILE_ID || ownAtLink)) void loadProfileOverview();
  } catch {
    profileStatus.textContent = "Could not save. Nothing changed.";
  } finally {
    profileSaveButton.disabled = false;
  }
});

async function refreshAccount() {
  try {
    await consumeAuthHandoff();
    const response = await apiFetch("/auth/me");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.authenticated) showSignedIn(payload.account);
    else {
      clearAuthSession();
      showSignedOut();
    }
  } catch {
    showSignedOut("Account service is temporarily unavailable. The public tools remain accessible.");
  }
}

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    const response = await apiFetch("/auth/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clearAuthSession();
    showSignedOut("You are signed out.");
    accountMenu.open = false;
  } catch {
    status.textContent = "Could not sign out. Please try again.";
  } finally {
    logoutButton.disabled = false;
  }
});

deleteAccountButton.addEventListener("click", async () => {
  const confirmation = window.prompt(
    "Delete your AniiLogs account, cloud progress, private profile, sessions, and active map shares? Local browser progress will remain. Type DELETE to confirm.",
  );
  if (confirmation !== "DELETE") {
    status.textContent = confirmation === null ? "Account deletion cancelled." : "Type DELETE exactly to delete your account.";
    return;
  }
  deleteAccountButton.disabled = true;
  try {
    const response = await apiFetch("/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmation }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    clearAuthSession();
    showSignedOut("Your cloud account and its saved data were deleted. Local browser progress was kept.");
    accountMenu.open = false;
  } catch {
    status.textContent = "Could not delete your account. Nothing was changed; please try again.";
  } finally {
    deleteAccountButton.disabled = false;
  }
});

const authResult = new URLSearchParams(window.location.search).get("auth");
if (authResult) {
  const messages = {
    cancelled: "Discord sign-in was cancelled.",
    failed: "Discord sign-in could not be completed.",
    invalid: "Discord returned an invalid or expired sign-in request.",
    unavailable: "Discord sign-in is awaiting deployment credentials.",
  };
  status.textContent = messages[authResult] || "Discord sign-in was not completed.";
  history.replaceState({}, "", window.location.pathname);
}

// ---------------------------------------------------------------- the profile page
// Only the profile shows (no home page above it), with a player search at the top: names or UIDs of public profiles.
function profileHref(params) {
  const next = new URLSearchParams(window.location.search);    // keeps ?embed=app, theme and uid in the app
  for (const key of ["profile", "view", "auth", "history", "as"]) next.delete(key);
  for (const [key, value] of Object.entries(params)) next.set(key, value);
  return `/?${next}`;
}
if (PROFILE_VIEW) {
  document.body.classList.add("profile-page");
  profileOverview.hidden = false;
  document.querySelector("[data-profile-finder]").hidden = false;
  const back = document.querySelector("[data-profile-back]");
  back.href = profileHref({ view: "profile" });
  // your profile editor (name, about, public switch) sits under "Edit profile" on your own profile
  document.querySelector("[data-profile-edit]").append(profileEditor);
  const input = document.querySelector("[data-profile-search-input]");
  const list = document.querySelector("[data-profile-search-results]");
  let timer = 0; let asked = "";
  const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); };
  const show = (items) => {
    list.replaceChildren(...items);
    list.hidden = !items.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      asked = q;
      try {
        const response = await apiFetch(`/profiles/search?q=${encodeURIComponent(q)}`);
        const { results = [] } = response.ok ? await response.json() : {};
        if (asked !== q) return;
        if (!results.length) { show([element("li", "profile-search-empty", "No public profile matches that name or UID.")]); return; }
        show(results.map((result) => {
          const item = element("li");
          const link = element("a");
          link.href = profileHref({ profile: result.publicId });
          link.setAttribute("role", "option");
          // a display-name match (its owner opted in) shows that name over their characters
          const [first, ...others] = result.characters;
          if (result.displayName) {
            const strong = element("strong");
            strong.append(shownName(result.displayName, result.nameSource));
            link.append(strong);
            if (result.characters.length) link.append(element("small", "", result.characters.map((c) => c.name).join(", ")));
          } else {
            link.append(element("strong", "", first.name), element("small", "", `UID ${first.gameUid}`));
            if (others.length) link.append(element("small", "", `also ${others.map((c) => c.name).join(", ")}`));
          }
          item.append(link);
          return item;
        }));
      } catch {
        show([element("li", "profile-search-empty", "Search isn't available right now.")]);
      }
    }, 250);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "ArrowDown") { event.preventDefault(); list.querySelector("a")?.focus(); }
  });
  list.addEventListener("keydown", (event) => {
    const links = [...list.querySelectorAll("a")]; const i = links.indexOf(document.activeElement);
    if (event.key === "ArrowDown" && i < links.length - 1) { event.preventDefault(); links[i + 1].focus(); }
    if (event.key === "ArrowUp") { event.preventDefault(); (i > 0 ? links[i - 1] : input).focus(); }
    if (event.key === "Escape") { close(); input.focus(); }
  });
  document.addEventListener("click", (event) => { if (!event.target.closest("[data-profile-finder]")) close(); });
}

// The profile's address: a public profile's link (the address bar shows it on your own too, with Copy link); a
// private profile has none, and its owner is told where to make one.
function showProfileLink(publicId, profile) {
  const share = profileOverview.querySelector("[data-profile-share]");
  const id = publicId || (profile?.publicId ? profile.profileUid || profile.publicId : "");
  const url = share.querySelector("[data-profile-share-url]");
  const note = share.querySelector("[data-profile-share-note]");
  share.hidden = !PROFILE_VIEW;
  share.querySelector("[data-profile-copy]").hidden = !id;
  // your own public profile: open it as a visitor sees it
  const preview = share.querySelector("[data-profile-preview-link]");
  preview.hidden = !id || Boolean(publicId);
  if (id) preview.href = `${profileHref({ profile: id })}&as=visitor`;
  const bar = profileOverview.querySelector("[data-profile-preview-bar]");
  bar.hidden = !VISITOR_PREVIEW;
  if (VISITOR_PREVIEW) bar.querySelector("a").href = profileHref({ profile: publicId });
  note.textContent = "";
  url.textContent = id ? `${window.location.origin}/?profile=${id}` : "Your profile is private, so it has no link yet. Make it public under Edit profile to get one.";
  url.classList.toggle("is-note", !id);
  if (PROFILE_VIEW && !publicId) {
    // your own profile: its public address in the address bar, or back to the Profiles page once it's private again
    const address = id ? profileHref({ profile: id }) : profileHref({ view: "profile" });
    if (`${window.location.pathname}${window.location.search}` !== address) window.history.replaceState(null, "", `${address}${window.location.hash}`);
  }
}
profileOverview.querySelector("[data-profile-copy]").addEventListener("click", async () => {
  const text = profileOverview.querySelector("[data-profile-share-url]").textContent;
  const note = profileOverview.querySelector("[data-profile-share-note]");
  try {
    await navigator.clipboard.writeText(text);
    note.textContent = "Link copied";
  } catch {
    window.getSelection()?.selectAllChildren(profileOverview.querySelector("[data-profile-share-url]"));
    note.textContent = "Press Ctrl+C to copy";
  }
});

function showAsOwner() {
  ownAtLink = true;
  document.querySelector("[data-profile-back]").hidden = true;
  document.querySelector("[data-profile-edit]").hidden = false;
}

// ---------------------------------------------------------------- the profile's cards (Arrange cards)
// The cards are the grid's [data-overview-panel] articles: one added to the page joins the arrangement by itself.
const cardGrid = profileOverview.querySelector(".profile-overview-grid");
const arrangeBar = profileOverview.querySelector("[data-profile-arrange-bar]");
const cardPanel = (id) => cardGrid.querySelector(`:scope > [data-overview-panel="${id}"]`);
// the site's own order, as the page lists the cards (read once: arranging moves them)
const siteCards = [...cardGrid.querySelectorAll(":scope > [data-overview-panel]")]
  .map((panel) => ({ id: panel.dataset.overviewPanel, title: panel.querySelector("h3")?.textContent || panel.dataset.overviewPanel }));
let savedLayout = { order: [], hidden: [] };
let draftCards = null;

function placeCards(list) {
  for (const card of list) {
    const panel = cardPanel(card.id);
    panel.classList.toggle("is-arranged-off", card.hidden);
    for (const width of window.AniiProfileCards.WIDTHS) panel.classList.toggle(`card-w${width}`, card.width === width && width > 1);
    for (const height of window.AniiProfileCards.HEIGHTS) if (height) panel.classList.toggle(`card-h-${height}`, card.height === height);
    cardGrid.append(panel);
  }
  fitCardHeights();
}
// By default no card is taller than the Collection card: its content's height (not the row's) caps the others.
const HEIGHT_REFERENCE = "collection";
function fitCardHeights() {
  const reference = cardPanel(HEIGHT_REFERENCE);
  const shown = reference && !reference.hidden && !reference.classList.contains("is-arranged-off") && reference.offsetParent;
  if (!shown) { cardGrid.style.removeProperty("--profile-card-max"); return; }
  const last = [...reference.children].filter((node) => node.offsetParent).at(-1);
  if (!last) return;
  const pad = parseFloat(getComputedStyle(reference).paddingBottom) || 0;
  const height = Math.ceil(last.getBoundingClientRect().bottom - reference.getBoundingClientRect().top + reference.scrollTop + pad);
  if (height > 120) cardGrid.style.setProperty("--profile-card-max", `${height}px`);
}
if (cardPanel(HEIGHT_REFERENCE)) {
  const reference = cardPanel(HEIGHT_REFERENCE);
  reference.classList.add("is-height-reference");
  new ResizeObserver(() => fitCardHeights()).observe(reference.querySelector("[data-overview-body]"));
  window.addEventListener("resize", () => fitCardHeights());
}
function applyCardLayout(layout) {
  savedLayout = layout || { order: [], hidden: [] };
  if (!draftCards) placeCards(window.AniiProfileCards.arrangeCards(siteCards, savedLayout));
}

function arrangeTools(card, index, count) {
  const tools = element("div", "profile-card-tools");
  tools.dataset.cardTools = "";
  const handle = element("span", "profile-card-handle", "⠿");
  handle.title = "Drag to move";
  handle.setAttribute("aria-hidden", "true");
  const button = (label, text, action, disabled = false) => {
    const node = element("button", "profile-tool-button", text);
    node.type = "button";
    node.setAttribute("aria-label", `${label}: ${card.title}`);
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  };
  const toggle = button(card.hidden ? "Show" : "Hide", card.hidden ? "Show" : "Hide", () => {
    draftCards = draftCards.map((item) => (item.id === card.id ? { ...item, hidden: !item.hidden } : item));
    renderDraft(card.id);
  });
  toggle.setAttribute("aria-pressed", String(card.hidden));
  const choice = (label, value, options, change) => {
    const select = element("select", "profile-card-size");
    select.setAttribute("aria-label", `${label}: ${card.title}`);
    select.title = label;
    for (const [optionValue, text] of options) {
      const option = element("option", "", text);
      option.value = String(optionValue);
      option.selected = optionValue === value;
      select.append(option);
    }
    select.addEventListener("change", () => {
      draftCards = draftCards.map((item) => (item.id === card.id ? change(item, select.value) : item));
      renderDraft();
      cardPanel(card.id).querySelector(`[data-card-tools] select[title="${label}"]`)?.focus();
    });
    return select;
  };
  const isReference = card.id === HEIGHT_REFERENCE;
  const width = choice("Width", card.width, [[1, "1 column"], [2, "2 columns"], [3, "3 columns"]],
    (item, value) => ({ ...item, width: Number(value) }));
  const height = choice("Max height", card.height, [["", isReference ? "Height: fits (sets the others)" : "Height: like Collection"],
    ["short", "Height: short"], ["medium", "Height: medium"], ["tall", "Height: tall"], ["none", "Height: no limit"]],
    (item, value) => ({ ...item, height: value }));
  tools.append(handle,
    button("Move up", "↑", () => { draftCards = window.AniiProfileCards.moveCard(draftCards, card.id, { step: -1 }); renderDraft(card.id, "up"); }, index === 0),
    button("Move down", "↓", () => { draftCards = window.AniiProfileCards.moveCard(draftCards, card.id, { step: 1 }); renderDraft(card.id, "down"); }, index === count - 1),
    toggle, width, height);
  if (card.hidden) tools.append(element("span", "profile-card-hidden-label", "Hidden"));
  return tools;
}
// keeps focus on the button that was used (or its neighbour when it's now disabled at an end)
function renderDraft(focusId = "", which = "") {
  placeCards(draftCards);
  draftCards.forEach((card, index) => {
    const panel = cardPanel(card.id);
    panel.querySelector("[data-card-tools]")?.remove();
    panel.prepend(arrangeTools(card, index, draftCards.length));
  });
  if (focusId) {
    const buttons = [...cardPanel(focusId).querySelectorAll("[data-card-tools] button")];
    const wanted = { up: buttons[0], down: buttons[1] }[which] || buttons[2];
    (wanted && !wanted.disabled ? wanted : buttons.find((node) => !node.disabled))?.focus();
  }
}
function setArranging(on) {
  cardGrid.classList.toggle("is-arranging", on);
  arrangeBar.hidden = !on;
  profileOverview.querySelector("[data-profile-arrange]").hidden = on;
  for (const panel of cardGrid.querySelectorAll(":scope > [data-overview-panel]")) {
    panel.draggable = on;
    if (!on) panel.querySelector("[data-card-tools]")?.remove();
  }
}
profileOverview.querySelector("[data-profile-arrange]").addEventListener("click", () => {
  draftCards = window.AniiProfileCards.arrangeCards(siteCards, savedLayout);
  arrangeBar.querySelector("[data-arrange-status]").textContent = "";
  setArranging(true);
  renderDraft();
  arrangeBar.scrollIntoView({ block: "nearest", behavior: "smooth" });
});
arrangeBar.querySelector("[data-arrange-reset]").addEventListener("click", () => {
  draftCards = window.AniiProfileCards.arrangeCards(siteCards, null);
  renderDraft();
});
arrangeBar.querySelector("[data-arrange-cancel]").addEventListener("click", () => {
  draftCards = null;
  setArranging(false);
  applyCardLayout(savedLayout);
});
arrangeBar.querySelector("[data-arrange-save]").addEventListener("click", async (event) => {
  const status = arrangeBar.querySelector("[data-arrange-status]");
  const save = event.currentTarget;
  save.disabled = true;
  status.textContent = "Saving…";
  try {
    const response = await apiFetch("/profile/layout", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(window.AniiProfileCards.layoutOf(draftCards, siteCards)),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.layout) throw new Error(payload.error || `HTTP ${response.status}`);
    draftCards = null;
    setArranging(false);
    applyCardLayout(payload.layout);
    profileOverview.querySelector("[data-overview-status]").textContent = "Your profile's cards are saved.";
  } catch {
    status.textContent = "Could not save. Nothing changed.";
  } finally {
    save.disabled = false;
  }
});
// drag and drop (a mouse); the arrows do the same on touch and keyboards
let draggedCard = "";
cardGrid.addEventListener("dragstart", (event) => {
  const panel = event.target.closest?.("[data-overview-panel]");
  if (!draftCards || !panel) return;
  draggedCard = panel.dataset.overviewPanel;
  panel.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", draggedCard);
});
cardGrid.addEventListener("dragover", (event) => {
  if (draftCards && draggedCard) event.preventDefault();
});
cardGrid.addEventListener("drop", (event) => {
  const target = event.target.closest?.("[data-overview-panel]");
  if (!draftCards || !draggedCard || !target) return;
  event.preventDefault();
  draftCards = window.AniiProfileCards.moveCard(draftCards, draggedCard, { to: draftCards.findIndex((card) => card.id === target.dataset.overviewPanel) });
  renderDraft();
});
cardGrid.addEventListener("dragend", () => {
  cardGrid.querySelector(".is-dragging")?.classList.remove("is-dragging");
  draggedCard = "";
});

// ---------------------------------------------------------------- Battle History
// Every run aLogs captured for this player (and runs a teammate's app captured with them in the party), newest first:
// the 5 newest on the profile's card, all of them at ?history=1 with filters. Pictures load when a run is opened.
const HISTORY_VIEW = PROFILE_VIEW && new URLSearchParams(window.location.search).get("history") === "1";
const historyFull = profileOverview.querySelector("[data-history-full]");
let historyPath = "";
let historyNext = null;
const historyLink = (on) => {
  const next = new URLSearchParams(window.location.search);
  if (on) next.set("history", "1"); else next.delete("history");
  return `/?${next}`;
};
const shortDate = (seconds) => new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const weekLabel = (week) => (week?.start ? `Week of ${shortDate(week.start)}` : "");

function historyTitle(run) {
  if (run.mode === "sim") return [run.trialName || "Holo-Battle Sim", run.difficulty].filter(Boolean).join(" · ");
  if (run.mode === "eggheist") return run.rank?.name ? `Egg Heist · ${run.rank.name}` : "Egg Heist";
  // a two-boss fight (weeks 4003-4005's center): both bosses, the first the run is filed under
  if (run.boss?.name && run.boss.second?.name) return `${run.boss.name} + ${run.boss.second.name}`;
  return run.boss?.name || "Holo-Battle Interlink";
}
function historyNumbers(run) {
  const parts = [];
  if (run.mode === "interlink" && run.score != null) parts.push(`${numberFormat.format(run.score)} pts`);
  if (run.mode === "eggheist" && run.score != null) parts.push(`${numberFormat.format(run.score)} pts`);
  if (run.stars != null && run.mode === "interlink") parts.push(`★ ${run.stars}`);
  // an Interlink run: cleared, quit before the clock ran out (the result screens still appear), or the clock ran out.
  // "unconfirmed" (a two-boss center that ended under the clock without every star, kept on the boards until a live
  // run shows how the two bosses' stars add up): its time alone, no ending
  if (run.outcome === "cleared") parts.push(`cleared in ${clockTime(run.clearTimeS)}`);
  else if (run.outcome === "ended-early") parts.push(`ended early at ${clockTime(run.clearTimeS)}`);
  else if (run.outcome === "time-up") parts.push("time up");
  else if (run.outcome === "invalid") parts.push(`quit at ${clockTime(run.clearTimeS)}`);
  else if (run.outcome === "unconfirmed") parts.push(clockTime(run.clearTimeS));
  else if (run.clearTimeS != null) parts.push(run.cleared ? `cleared in ${clockTime(run.clearTimeS)}` : run.mode === "interlink" ? "no clear" : clockTime(run.clearTimeS));
  if (run.floors != null) parts.push(`${run.floors} floors`);
  return parts.join(" · ");
}
function historyChips(run) {
  const chips = [];
  const chip = (cls, text, title = "") => { const node = element("span", `history-chip ${cls}`, text); if (title) node.title = title; chips.push(node); };
  if (run.check === "verified") chip("is-verified", "Verified", "Checked: the site read this run's full screenshots again and they agree.");
  if (run.check === "pending") chip("is-pending", "Pending", "Waiting for a check against this run's full screenshots.");
  if (run.newBests?.length) chip("is-best", "New best", "This run beat one of the player's bests when it was captured.");
  if (run.outcome === "ended-early") chip("is-early", "Ended early", "The team had every star and the leader ended the run: it counts.");
  if (run.outcome === "invalid") chip("is-invalid", "Invalid", "Quit before the run could count (under the clock without every star): it's on no board.");
  if (run.credited) chip("is-credited", "Teammate's capture", "A teammate's aLogs captured this run with this player in the party.");
  if (run.captures > 1) chip("is-shared", `Captured by ${run.captures} players`, "The same run, sent by more than one player in the party.");
  if (run.hidden) chip("is-hidden", "Hidden", "Hidden from the boards: only you see it here.");
  return chips;
}
// "Party at the start": the Party screen's last capture before the battle (the leader or anyone could still change
// things until then). The picture is the proof; beside it, as text, each player's lead Aniimo, its level and CP and
// their team comp (whichever teammate's copy read them), and what the whole party shares: the buffs the leader chose.
function historyLineup(run) {
  const read = (entry) => entry && !entry.ai && (entry.aniimo || Number.isInteger(entry.cp) || entry.team?.length > 1);
  const players = (Array.isArray(run.lineup) ? run.lineup : []).filter(read);
  const buffs = Array.isArray(run.buffs) ? run.buffs : [];
  const picture = run.hasPartyScreen && !run.proofPrunedAt;
  if (!players.length && !buffs.length && !picture) return null;
  const panel = element("section", "history-lineup");
  if (picture) {
    const base = `${API_URL}/leaderboard/submissions/${encodeURIComponent(run.submissionId)}/evidence?shot=party`;
    const link = element("a", "history-shot is-party");
    link.href = base;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = "The Party screen when the battle started: open it";
    const image = element("img");
    image.alt = "The Party screen when the battle started";
    image.loading = "lazy";
    image.dataset.src = base;
    link.append(image, element("span", "", "Party screen at the start"));
    panel.append(link);
  }
  // One block per player: their name, their lead Aniimo (level, CP) beside it, and the rest of their team as small
  // chips underneath (the lead isn't repeated). Every Aniimo name links to its Aniilog page.
  const facts = element("div", "history-lineup-facts");
  const level = (entry) => (Number.isInteger(entry.aniimoLevel) ? `Lv ${entry.aniimoLevel}` : "");
  const cp = (entry) => (Number.isInteger(entry.cp) ? `CP ${numberFormat.format(entry.cp)}` : "");
  if (players.length) {
    facts.append(element("p", "history-section-label", "Party at the start"));
    const list = element("ul", "lineup-players");
    for (const player of players) {
      const item = element("li", "lineup-player");
      const head = element("div", "lineup-head");
      head.append(element("span", "lineup-name", player.name || (player.slot ? `${player.slot}P` : "Player")));
      if (player.aniimo) {
        const lead = element("span", "lineup-lead");
        lead.append(aniimoNameLink(player.aniimo));
        const meta = [level(player), cp(player)].filter(Boolean).join(" · ");
        if (meta) lead.append(element("small", "lineup-meta", meta));
        head.append(lead);
      }
      item.append(head);
      // the whole team only when aLogs read more than the lead (the rest are icons, there in the picture)
      const team = Array.isArray(player.team) && player.team.length > 1 ? [...player.team] : [];
      const leadAt = team.findIndex((member) => member.aniimo === player.aniimo);
      if (leadAt >= 0) team.splice(leadAt, 1);
      if (team.length) {
        const chips = element("ul", "lineup-team");
        chips.setAttribute("aria-label", `${player.name || "This player"}'s team`);
        for (const member of team) {
          const chip = element("li", "lineup-chip");
          chip.append(aniimoNameLink(member.aniimo));
          if (level(member)) chip.append(element("small", "", level(member)));
          if (cp(member)) chip.title = cp(member);
          chips.append(chip);
        }
        item.append(chips);
      }
      list.append(item);
    }
    facts.append(list);
  }
  if (buffs.length) {
    const line = element("div", "lineup-buffs");
    line.append(element("span", "lineup-label", "Team buffs"));
    for (const buff of buffs) line.append(element("span", "lineup-chip is-buff", `${buff.name}${Number.isInteger(buff.level) ? ` ${buff.level}` : ""}`));
    facts.append(line);
  }
  if (!picture) facts.append(element("p", "history-empty", run.proofPrunedAt ? "The Party screen's picture is no longer kept." : "No picture of the Party screen with this run."));
  panel.append(facts);
  return panel;
}
function historyParty(run) {
  let players = (run.players || []).filter((player) => player && (player.name || player.avgDps != null));
  // no Battle Data read: the party from the Party screen (names only)
  if (!players.length && Array.isArray(run.lineup)) players = run.lineup.filter((item) => item?.name).map(({ name, ai, self }) => ({ name, ai, self }));
  if (!players.length) return element("p", "history-empty", "No party read for this run.");
  const table = element("table", "history-party");
  const head = element("tr");
  for (const label of ["", "Player", "Avg DPS", "BREAK", "Damage Taken", "Healing"]) head.append(element("th", "", label));
  const thead = element("thead");
  thead.append(head);
  const body = element("tbody");
  players.forEach((player, index) => {
    const row = element("tr");
    const who = element("td", "history-player");
    if (player.profileId && !player.ai) {
      const link = element("a", "", player.name);
      link.href = profileHref({ profile: player.profileId });
      who.append(link);
    } else who.append(document.createTextNode(player.name || `Player ${index + 1}`));
    if (player.ai) who.append(element("span", "history-chip is-ai", "AI"));
    if (player.self && run.credited) who.append(element("span", "history-chip is-self", "captured it"));   // the teammate whose app sent it
    // each figure carries its column's name: a narrow card shows each player as a block of labelled figures (styles.css)
    const number = (value, label) => {
      const cell = element("td", "history-number", value == null ? "–" : numberFormat.format(value));
      cell.dataset.label = label;
      return cell;
    };
    row.append(element("td", "history-slot", `${index + 1}P`), who, number(player.avgDps, "Avg DPS"), number(player.breakValue, "BREAK"),
      number(player.damageTaken, "Taken"), number(player.heal, "Healing"));
    body.append(row);
  });
  table.append(thead, body);
  const wrap = element("div", "history-party-wrap");
  wrap.append(element("p", "history-section-label", "Battle Data"), table);
  return wrap;
}
function historyProof(run) {
  const box = element("div", "history-proof");
  if (run.proofPrunedAt) {
    box.append(element("p", "history-empty", "The pictures of this run are no longer kept (it isn't a best; pictures of other runs are kept 90 days). Its numbers stay."));
    return box;
  }
  const gizmos = Number(run.gizmoShots) || 0;          // Holo-Battle Sim's Gizmo screen, a view per part of its list
  const shots = [["", "Result", run.hasEvidence, "full"], ["battle", run.kind === "eggheist_match" ? "Rank summary" : "Battle Data", run.hasBattleEvidence, "battle_full"],
    ...Array.from({ length: gizmos }, (_, i) => [`gizmo${i + 1}`, gizmos > 1 ? `Gizmos ${i + 1}` : "Gizmos", true, null])].filter(([, , has]) => has);
  if (!shots.length) { box.append(element("p", "history-empty", "No pictures with this run.")); return box; }
  for (const [shot, label, , full] of shots) {
    const base = `${API_URL}/leaderboard/submissions/${encodeURIComponent(run.submissionId)}/evidence`;
    const link = element("a", "history-shot");
    const fullKey = full === "full" ? "evidence" : full ? "battle" : null;   // a Gizmo view is the whole screen already
    link.href = run.hasFullScreens?.includes(fullKey) ? `${base}?shot=${full}` : `${base}${shot ? `?shot=${shot}` : ""}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.title = run.hasFullScreens?.includes(fullKey) ? `${label}: open the whole screenshot` : `${label}: open the picture`;
    const picture = element("img");
    picture.alt = `${label} screen of this run`;
    picture.loading = "lazy";
    picture.decoding = "async";
    picture.dataset.src = `${base}${shot ? `?shot=${shot}` : ""}`;
    link.append(picture, element("span", "", label));
    box.append(link);
  }
  return box;
}
function historyRow(run, { open = false } = {}) {
  const item = element("li", "history-run");
  item.id = `run-${run.submissionId}`;
  const details = element("details");
  const summary = element("summary");
  const title = element("span", "history-title");
  title.append(element("strong", "", historyTitle(run)));
  const when = [weekLabel(run.week), run.playedAt ? new Date(run.playedAt * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""].filter(Boolean).join(" · ");
  title.append(element("small", "", when));
  const numbers = element("span", "history-numbers", historyNumbers(run));
  const chips = element("span", "history-chips");
  chips.append(...historyChips(run));
  summary.append(title, numbers, chips);
  details.append(summary);
  disclosure(details);
  details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.filled) return;
    details.dataset.filled = "1";
    const body = element("div", "history-body");
    const evidence = element("div", "history-evidence");
    const lineup = historyLineup(run);
    if (lineup) evidence.append(lineup);
    evidence.append(historyProof(run));
    body.append(historyParty(run), evidence);
    details.append(body);
    for (const picture of body.querySelectorAll("img[data-src]")) {
      picture.addEventListener("error", () => picture.closest("a")?.replaceWith(element("p", "history-empty", "This picture couldn't be loaded.")), { once: true });
      picture.src = picture.dataset.src;
    }
  });
  details.open = open;
  item.append(details);
  return item;
}

async function fetchHistory(params) {
  const response = await apiFetch(`${historyPath}?${params}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
// the card on the profile: the 5 newest, and See all
async function loadHistoryCard() {
  const body = overviewBody("history");
  body.replaceChildren(element("p", "", "Loading…"));
  try {
    const { runs = [] } = await fetchHistory(new URLSearchParams({ limit: "5" }));
    if (!runs.length) { body.replaceChildren(element("p", "", "No runs captured yet. aLogs adds every run it sees here.")); return; }
    const list = element("ol", "profile-history-list is-compact");
    list.append(...runs.map((run) => historyRow(run)));
    const more = element("a", "history-see-all", historyPath === "/profile/history" ? "See all my runs" : "See all recent runs");
    more.href = historyLink(true);
    body.replaceChildren(list, more);
  } catch {
    body.replaceChildren(element("p", "", "Battle History couldn't be loaded right now."));
  }
}
// the filter menus, from the first page's counts (once)
function fillHistoryFilters(filters) {
  if (historyFull.dataset.filtersReady) return;
  historyFull.dataset.filtersReady = "1";
  const fill = (name, items) => {
    const select = historyFull.querySelector(`[data-history-filter="${name}"]`);
    select.append(...items.map(([value, label]) => { const option = element("option", "", label); option.value = value; return option; }));
    select.closest("label").hidden = items.length < 2;
  };
  fill("mode", filters.modes.map((row) => [row.value, `${HISTORY_MODE_NAMES[row.value] || row.value} (${row.count})`]));
  fill("boss", filters.bosses.map((row) => [row.id, `${row.name || row.id} (${row.count})`]));
  fill("cycle", filters.weeks.map((row) => [row.value, `${weekLabel(row) || `Week ${row.value}`} (${row.count})`]));
  // the long lists get the site's type-to-filter box (/explorer/aniimo-picker.js); a pick fires the select's "change"
  for (const name of ["boss", "cycle"]) {
    const select = historyFull.querySelector(`[data-history-filter="${name}"]`);
    window.AniilogsPicker?.makeCombobox(select, { placeholder: select.options[0]?.text || "Type to filter", emptyText: "No matches" });
  }
}
// ---------------------------------------------------------------- My runs
// The full Battle History on your own profile: only you see it (the owner-only /api/profile/history). Every run in a
// row: its mode, the fight and its week, when it was played, the result, who you were with and what each did (Battle
// Data), and its pictures in the leaderboards' proof viewer (/proof-viewer.js). A search box that filters as you type
// (boss, teammate, mode, date), numbered pages of 20, 30 or 50 (remembered), counted on the server.
const MY_RUNS_PAGE_SIZE_KEY = "aniilogs:my-runs:page-size:v1";
const MY_RUNS_PAGE_SIZES = [20, 30, 50];
const MY_RUNS_SEARCH_WAIT_MS = 250;
const HISTORY_MODE_NAMES = { interlink: "Holo-Battle Interlink", sim: "Holo-Battle Sim", eggheist: "Egg Heist", menu: "Menu bests" };
// The table's column headers sort it on the server (it's paged): Played, newest first, unless another is clicked.
// Each starts in its natural order (A–Z, or highest/newest first); clicked again it flips. The rows are shown in the
// order the server sends them.
const MY_RUNS_SORTS = Object.freeze({ played: "desc", mode: "asc", fight: "asc", result: "desc", party: "desc" });
const myRuns = { on: false, page: 1, pageSize: 20, request: 0, timer: null, scope: null, sort: "played", order: "desc" };
let runsArePublic = false;
function renderMyRunsHead() {
  for (const cell of historyFull.querySelectorAll("[data-myruns-sort]")) {
    const key = cell.dataset.myrunsSort;
    cell.dataset.label ||= cell.textContent.trim();
    window.AniilogsTableSort?.fillHeader(cell, cell.dataset.label, {
      active: myRuns.sort === key, order: myRuns.order,
      onSort: () => {
        ({ key: myRuns.sort, order: myRuns.order } = window.AniilogsTableSort.nextSort({ key: myRuns.sort, order: myRuns.order }, key, MY_RUNS_SORTS[key]));
        myRuns.page = 1;
        renderMyRunsHead();
        void loadMyRuns();
      },
    });
  }
}
// ?split=<id>[&best=1][&label=Season 1.0]: one part of an Interlink season (the profile's Interlink card links here)
function runsScopeFromAddress() {
  const params = new URLSearchParams(window.location.search);
  const split = params.get("split");
  if (!/^\d{1,4}$/u.test(split || "")) return null;
  return { split, best: params.get("best") === "1", label: String(params.get("label") || "").slice(0, 40) };
}
function myRunsPageSize() {
  try {
    const saved = Number(window.localStorage.getItem(MY_RUNS_PAGE_SIZE_KEY));
    return MY_RUNS_PAGE_SIZES.includes(saved) ? saved : 20;
  } catch { return 20; }
}
function runModeLabel(run) {
  if (run.kind === "interlink_best") return "Interlink · menu best";
  if (run.kind === "eggheist_season") return "Egg Heist · season rank";
  return HISTORY_MODE_NAMES[run.mode] || run.mode || "Run";
}
function runFightWhen(run) {
  if (run.mode === "interlink") return weekLabel(run.week) || (run.cycle ? `Week ${run.cycle}` : "");
  return run.cycle ? `Season ${run.cycle}` : "";
}
function runResult(run) {
  if (run.kind === "interlink_best") {
    return [run.score != null ? `${numberFormat.format(run.score)} pts` : "", run.stars != null ? `★ ${run.stars}` : "", "from the game's menu"].filter(Boolean).join(" · ");
  }
  if (run.kind === "eggheist_season") return [run.rank?.name, run.score != null ? `${numberFormat.format(run.score)} rank points` : ""].filter(Boolean).join(" · ") || "—";
  return historyNumbers(run) || "—";
}
// each player on a line: their name, then what they did, as on Battle Data
function runPartyCell(run) {
  let players = (run.players || []).filter((player) => player && (player.name || player.avgDps != null));
  if (!players.length && Array.isArray(run.lineup)) players = run.lineup.filter((item) => item?.name).map(({ name, ai, self }) => ({ name, ai, self }));
  if (!players.length) return element("span", "history-empty", run.kind === "interlink_best" ? "Not on the menu" : "No party read");
  const list = element("ul", "myruns-party");
  for (const [index, player] of players.entries()) {
    const item = element("li");
    const who = element("span", "myruns-who");
    if (player.profileId && !player.ai) {
      const link = element("a", "", player.name);
      link.href = profileHref({ profile: player.profileId });
      who.append(link);
    } else who.append(document.createTextNode(player.name || `Player ${index + 1}`));
    if (player.ai) who.append(element("span", "history-chip is-ai", "AI"));
    if (player.self && run.credited) who.append(element("span", "history-chip is-self", "captured it"));
    item.append(who);
    const figures = [["DPS", player.avgDps], ["BREAK", player.breakValue], ["Taken", player.damageTaken], ["Heal", player.heal]]
      .filter(([, value]) => value != null);
    if (figures.length) {
      const stats = element("span", "myruns-stats");
      for (const [label, value] of figures) {
        const stat = element("span");
        stat.append(element("small", "", label), document.createTextNode(` ${numberFormat.format(value)}`));
        stats.append(stat);
      }
      item.append(stats);
    }
    list.append(item);
  }
  return list;
}
function runProofCell(run) {
  if (run.proofPrunedAt) return element("span", "history-empty", "No longer kept");
  const has = run.hasEvidence || run.hasBattleEvidence || run.hasPartyScreen || Number(run.gizmoShots) > 0 || run.menuProofId;
  const button = has && window.AniilogsProof ? window.AniilogsProof.button(run.submissionId, run.check, run.menuProofId || null) : null;
  if (!button) return element("span", "history-empty", "None");
  button.classList.add("myruns-proof");
  button.append(element("span", "", "View"));
  return button;
}
function myRunRow(run) {
  const row = element("tr");
  row.id = `run-${run.submissionId}`;
  const cell = (label, ...children) => {
    const td = element("td");
    td.dataset.label = label;
    td.append(...children.filter(Boolean));
    row.append(td);
  };
  cell("Mode", element("span", "myruns-mode", runModeLabel(run)));
  const fight = element("span", "myruns-fight");
  fight.append(element("strong", "", historyTitle(run)));
  const when = runFightWhen(run);
  if (when) fight.append(element("small", "", when));
  cell("Fight", fight);
  const played = run.playedAt ? new Date(run.playedAt * 1000) : null;
  const time = element("time", "myruns-played", played
    ? played.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : "—");
  if (played) time.dateTime = played.toISOString();
  cell("Played", time);
  const result = element("span", "myruns-result");
  result.append(element("span", "", runResult(run)));
  const chips = element("span", "history-chips");
  chips.append(...historyChips(run));
  if (chips.childElementCount) result.append(chips);
  cell("Result", result);
  cell("Party", runPartyCell(run));
  cell("Proof", runProofCell(run));
  return row;
}
// the page buttons: Previous, 1 … 4 5 6 … 12, Next
function renderMyRunsPager(page, pages) {
  const pager = historyFull.querySelector("[data-myruns-pager]");
  pager.replaceChildren();
  pager.hidden = pages <= 1;
  if (pages <= 1) return;
  const go = (label, target, { current = false, disabled = false, aria = "" } = {}) => {
    const button = element("button", current ? "is-current" : "", label);
    button.type = "button";
    button.disabled = disabled || current;
    if (current) button.setAttribute("aria-current", "page");
    if (aria) button.setAttribute("aria-label", aria);
    button.addEventListener("click", () => {
      myRuns.page = target;
      void loadMyRuns();
      historyFull.querySelector("[data-myruns-summary]")?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    pager.append(button);
  };
  go("‹ Previous", page - 1, { disabled: page <= 1, aria: "Previous page" });
  const shown = [...new Set([1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages))].sort((a, b) => a - b);
  shown.forEach((n, index) => {
    if (index && n - shown[index - 1] > 1) pager.append(element("span", "myruns-gap", "…"));
    go(String(n), n, { current: n === page, aria: `Page ${n}` });
  });
  go("Next ›", page + 1, { disabled: page >= pages, aria: "Next page" });
}
// while a search waits for the server, the rows already shown are narrowed at once
function narrowShownRuns(text) {
  const words = text.toLowerCase().split(/\s+/u).filter(Boolean);
  for (const row of historyFull.querySelectorAll("[data-myruns-rows] tr")) {
    const haystack = row.textContent.toLowerCase();
    row.hidden = words.some((word) => !haystack.includes(word));
  }
}
async function loadMyRuns() {
  const rows = historyFull.querySelector("[data-myruns-rows]");
  const status = historyFull.querySelector("[data-history-status]");
  const summary = historyFull.querySelector("[data-myruns-summary]");
  const params = new URLSearchParams({ page: String(myRuns.page), limit: String(myRuns.pageSize), tz: String(-new Date().getTimezoneOffset()),
    sort: myRuns.sort, order: myRuns.order });
  for (const select of historyFull.querySelectorAll("[data-history-filter]")) if (select.value) params.set(select.dataset.historyFilter, select.value);
  const search = historyFull.querySelector("[data-history-search]").value.trim();
  if (search) params.set("q", search);
  if (myRuns.scope) {
    params.set("split", myRuns.scope.split);
    if (myRuns.scope.best) params.set("best", "1");
  }
  const request = ++myRuns.request;
  if (!rows.childElementCount) status.textContent = "Loading…";
  historyFull.classList.add("is-loading");
  try {
    const page = await fetchHistory(params);
    if (request !== myRuns.request) return;              // a newer search or page is on its way
    if (page.filters) fillHistoryFilters(page.filters);
    // past the last page (the list got shorter): the last page
    // (an API from before My runs sends one page and no counts)
    const pages = Number(page.pages) || 1;
    const current = Number(page.page) || 1;
    const total = Number(page.total ?? page.runs.length) || 0;
    if (!page.runs.length && total && myRuns.page > pages) { myRuns.page = pages; void loadMyRuns(); return; }
    rows.replaceChildren(...page.runs.map(myRunRow));
    const first = (current - 1) * (Number(page.pageSize) || myRuns.pageSize) + 1;
    summary.textContent = total
      ? `${numberFormat.format(first)}–${numberFormat.format(first + page.runs.length - 1)} of ${numberFormat.format(total)} run${total === 1 ? "" : "s"}` : "";
    historyFull.querySelector(".myruns-wrap").hidden = !page.runs.length;
    const filtered = search || ["mode", "boss", "cycle", "split"].some((name) => params.has(name));
    status.textContent = page.runs.length ? "" : filtered ? "No runs match." : "No runs captured yet. aLogs adds every run it sees here.";
    renderMyRunsPager(current, pages);
    if (window.location.hash.startsWith("#run-")) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "center" });
  } catch {
    if (request === myRuns.request) status.textContent = "My runs couldn't be loaded right now.";
  } finally {
    if (request === myRuns.request) historyFull.classList.remove("is-loading");
  }
}
function startMyRuns(publicId = null) {
  myRuns.on = true;
  myRuns.pageSize = myRunsPageSize();
  myRuns.scope = runsScopeFromAddress();
  historyFull.classList.add("is-my-runs");
  historyFull.querySelector("#history-title").textContent = publicId ? "Recent runs" : "My runs";
  historyFull.querySelector("[data-history-intro]").textContent = publicId
    ? "Every run aLogs captured for this player, newest first, including runs a teammate's app captured with them in the party, and their menu bests."
    : `${runsArePublic ? "Public: visitors to your profile see this list too" : "Only you can see this list"}: every run aLogs captured for you, newest first, `
      + "including runs a teammate's app captured with you in the party, and your menu bests.";
  // a season part's runs, with a way back to all of them
  const scope = historyFull.querySelector("[data-myruns-scope]");
  if (myRuns.scope) {
    const all = element("a", "", "Show all runs");
    const next = new URLSearchParams(window.location.search);
    for (const key of ["split", "best", "label"]) next.delete(key);
    all.href = `/?${next}`;
    scope.replaceChildren(element("strong", "", `${myRuns.scope.best ? "Best runs" : "Runs"} of ${myRuns.scope.label || "this season part"}`),
      document.createTextNode(myRuns.scope.best ? " (each boss's best of each week, as the season total counts them) · " : " · "), all);
    scope.hidden = false;
  }
  for (const node of historyFull.querySelectorAll("[data-myruns-only]")) node.hidden = false;
  renderMyRunsHead();
  historyFull.querySelector("[data-history-list]").hidden = true;
  historyFull.querySelector("[data-history-more]").hidden = true;
  const size = historyFull.querySelector("[data-history-page-size]");
  size.value = String(myRuns.pageSize);
  size.addEventListener("change", () => {
    myRuns.pageSize = MY_RUNS_PAGE_SIZES.includes(Number(size.value)) ? Number(size.value) : 20;
    try { window.localStorage.setItem(MY_RUNS_PAGE_SIZE_KEY, String(myRuns.pageSize)); } catch { /* not remembered */ }
    myRuns.page = 1;
    void loadMyRuns();
  });
  const search = historyFull.querySelector("[data-history-search]");
  search.addEventListener("input", () => {
    narrowShownRuns(search.value);
    clearTimeout(myRuns.timer);
    myRuns.timer = setTimeout(() => { myRuns.page = 1; void loadMyRuns(); }, MY_RUNS_SEARCH_WAIT_MS);
  });
  void loadMyRuns();
}

// the full view on someone else's public profile: filters, a page at a time
async function loadHistoryPage(reset) {
  const list = historyFull.querySelector("[data-history-list]");
  const status = historyFull.querySelector("[data-history-status]");
  const more = historyFull.querySelector("[data-history-more]");
  const params = new URLSearchParams();
  for (const select of historyFull.querySelectorAll("[data-history-filter]")) if (select.value) params.set(select.dataset.historyFilter, select.value);
  if (!reset && historyNext) params.set("before", historyNext);
  if (reset) list.replaceChildren();
  status.textContent = "Loading…";
  more.hidden = true;
  try {
    const page = await fetchHistory(params);
    if (page.filters) fillHistoryFilters(page.filters);
    list.append(...page.runs.map((run) => historyRow(run, { open: window.location.hash === `#run-${run.submissionId}` })));
    historyNext = page.next;
    more.hidden = !historyNext;
    status.textContent = list.children.length ? "" : "No runs match these filters.";
    if (reset && window.location.hash.startsWith("#run-")) document.getElementById(window.location.hash.slice(1))?.scrollIntoView({ block: "center" });
  } catch {
    status.textContent = "Battle History couldn't be loaded right now.";
  }
}
function showBattleHistory(publicId) {
  historyPath = publicId ? `/profiles/${encodeURIComponent(publicId)}/history` : "/profile/history";
  if (HISTORY_VIEW) {
    historyFull.hidden = false;
    historyFull.querySelector("[data-history-back]").href = historyLink(false);
    if (!historyFull.dataset.started) {
      historyFull.dataset.started = "1";
      startMyRuns(publicId);
    }
  } else {
    // your own profile's card leads to My runs (and says who else sees it); a visitor's to Recent runs
    const panel = profileOverview.querySelector('[data-overview-panel="history"]');
    panel.querySelector("h3").textContent = publicId ? "Recent runs" : "My runs";
    let note = panel.querySelector("[data-history-visibility]");
    if (!publicId) {
      if (!note) { note = element("p", "history-visibility"); note.dataset.historyVisibility = ""; panel.querySelector("h3").after(note); }
      note.textContent = runsArePublic ? "Public: visitors to your profile see this list as Recent runs." : "Private: only you see this list. Change it in Edit profile.";
    } else note?.remove();
    void loadHistoryCard();
  }
}
if (HISTORY_VIEW) {
  document.body.classList.add("profile-history-view");
  for (const select of historyFull.querySelectorAll("[data-history-filter]")) select.addEventListener("change", () => {
    if (myRuns.on) { myRuns.page = 1; void loadMyRuns(); return; }
    historyNext = null;
    void loadHistoryPage(true);
  });
  historyFull.querySelector("[data-history-more]").addEventListener("click", () => void loadHistoryPage(false));
}

if (!API_URL) {
  for (const link of loginLinks) {
    link.href = "#profiles";
    link.classList.add("is-disabled");
    link.setAttribute("aria-disabled", "true");
    link.textContent = "Discord sign-in soon";
  }
  status.textContent = "Account sync is awaiting its branded API origin. The public tools remain available to everyone.";
} else {
  configureLoginLinks();
  void refreshAccount();
  if (PUBLIC_PROFILE_ID) void loadProfileOverview(PUBLIC_PROFILE_ID);
}
