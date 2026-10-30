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
  || /^[A-Za-z0-9]{8,24}$/u.test(new URLSearchParams(window.location.search).get("profile") || "");
const profilePublic = document.querySelector("[data-profile-public]");
const profilePublicRow = document.querySelector("[data-profile-public-row]");
const profilePublicLink = document.querySelector("[data-profile-public-link]");
const profileFindable = document.querySelector("[data-profile-findable]");
const profileFindableRow = document.querySelector("[data-profile-findable-row]");
const profileShowPresence = document.querySelector("[data-profile-presence]");
const profilePresenceRow = document.querySelector("[data-profile-presence-row]");
const profileSearchRow = document.querySelector("[data-profile-search-row]");
const profileListedInSearch = document.querySelector("[data-profile-search]");
// /?view=profile is the profile page: your own profile (or a sign-in prompt), with a search for anyone else's.
// /?profile=<id> shows someone's public profile (read-only) in the same view.
const PUBLIC_PROFILE_ID = /^[A-Za-z0-9]{8,24}$/u.test(new URLSearchParams(window.location.search).get("profile") || "")
  ? new URLSearchParams(window.location.search).get("profile")
  : "";
// true once the server says the profile at ?profile=<id> is the viewer's own
let ownAtLink = false;
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
  if (token) headers.set("authorization", `Bearer ${token}`);
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
  void loadPrivateProfile(name);
  if (PROFILE_VIEW) {
    document.querySelector("[data-profile-signin]").hidden = true;
    // on someone else's profile (your own link shows your own: showAsOwner)
    document.querySelector("[data-profile-back]").hidden = !PUBLIC_PROFILE_ID || ownAtLink;
    document.querySelector("[data-profile-edit]").hidden = Boolean(PUBLIC_PROFILE_ID) && !ownAtLink;
  }
  if (PROFILE_VIEW && !PUBLIC_PROFILE_ID) void loadProfileOverview();   // your profile: on the Profiles page only
}

profilePublic.addEventListener("change", () => {
  profileFindable.disabled = !profilePublic.checked;
  profileListedInSearch.disabled = !profilePublic.checked;
});

function showVisibility(profile) {
  profilePublic.checked = Boolean(profile.isPublic);
  profileFindable.checked = Boolean(profile.findableByName);
  profileFindable.disabled = !profile.isPublic;
  profileListedInSearch.checked = profile.listedInSearch !== false;
  profileListedInSearch.disabled = !profile.isPublic;
  profileShowPresence.checked = profile.showPresence !== false;
  profileStatus.textContent = profile.isPublic ? "Public · anyone with the link can see it" : "Private · visible only to you";
  profilePublicLink.hidden = !(profile.isPublic && profile.publicId);
  if (profile.isPublic && profile.publicId) {
    const link = element("a", "", `${window.location.origin}/?profile=${profile.publicId}`);
    link.href = `/?profile=${profile.publicId}`;
    profilePublicLink.replaceChildren("Your profile link: ", link);
  }
}

async function loadPrivateProfile(fallbackName = "") {
  profileEditor.hidden = false;
  profileStatus.textContent = "Loading your private profile…";
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
    status.textContent = "Signed in, but your private profile could not be loaded.";
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

function renderInterlink(boards) {
  const body = overviewBody("interlink");
  const bosses = new Map();
  // Result-screen runs and battle-prep bests describe the same boss; show the higher of the two.
  for (const kind of ["interlink_best", "interlink_run"]) {
    for (const entry of boards[kind] || []) {
      const key = entry.boss?.id || entry.boss?.name;
      const prior = bosses.get(key);
      if (!prior || (entry.score || 0) > (prior.entry.score || 0)) bosses.set(key, { entry, kind });
    }
  }
  const bossRows = [...bosses.values()].map(({ entry, kind }) => standingRow(
    entry.boss?.level ? `${entry.boss.name || entry.boss.id} · Lv ${entry.boss.level}` : (entry.boss?.name || "Boss"),
    entry,
    kind,
    [`${numberFormat.format(entry.score || 0)} pts`],
    true,
  ));
  const weekRows = (boards.interlink_week || []).map((entry) => standingRow(
    entry.cycle ? `Week ${entry.cycle}` : "Weekly total",
    entry,
    "interlink_week",
    [`${numberFormat.format(entry.score || 0)} pts`],
  ));
  const season = boards.interlinkSeason;
  const seasonRows = [];
  if (season && season.total) {
    // Season standing: every week's best scores added up, with the challenge-rating stars earned
    const row = element("li");
    const link = element("a", "profile-position", `#${season.rank}`);
    link.href = `/leaderboard/?mode=interlink&kind=interlink_season_view&season=${season.season}`;
    link.title = `Position ${season.rank} of ${season.players} players this season · open the season board`;
    const stars = element("span", "profile-stars");
    stars.append(starIcon(), element("span", "", numberFormat.format(season.stars)));
    row.append(element("span", "", `Season ${season.season}`), link);
    const detail = element("small", "", `of ${numberFormat.format(season.players)} · ${numberFormat.format(season.total)} pts · `);
    detail.append(stars, ` · ${season.weeks} week${season.weeks === 1 ? "" : "s"}`);
    row.append(detail);
    seasonRows.push(row);
  }
  if (!bossRows.length && !weekRows.length && !seasonRows.length) {
    body.replaceChildren(element("p", "", "No Interlink scores yet. The desktop app sends them after each boss fight."));
    return;
  }
  body.replaceChildren(standingList("This season", seasonRows), standingList("Best per boss", bossRows), standingList("Weekly total", weekRows));
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
        !emperor && progress.lastGain != null ? `+${numberFormat.format(progress.lastGain)} last match` : "",
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
        chip.href = `/explorer/?view=aniilog&aniimo=${encodeURIComponent(id)}`;
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
      for (const panel of profileOverview.querySelectorAll("[data-overview-panel]")) panel.hidden = true;
      profileOverview.querySelector("[data-overview-name]").textContent = "Profile not found";
      overviewStatus.textContent = "This profile is private or doesn't exist.";
      describeForSearch({ title: "AniiLogs — Profile not found", noindex: true });
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
    profileOverview.querySelector("[data-overview-name]").textContent = overview.profile?.displayName || "My profile";
    profileOverview.querySelector("[data-overview-visibility]").textContent = publicId ? "Public profile"
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
    const characters = (overview.characters || []).map((character) => {
      // name, gender mark, level and server, as far as the desktop app has seen them
      const name = [
        `${character.name || `UID ${character.gameUid}`}${{ female: " ♀", male: " ♂" }[character.gender] || ""}`,
        Number.isInteger(character.level) ? `Lv ${character.level}` : "",
        character.server || "",
      ].filter(Boolean).join(" · ");
      return mainName && character.name === mainName ? `${name} (main)` : name;
    });
    profileOverview.querySelector("[data-overview-characters]").textContent = characters.length
      ? `Characters: ${characters.join(", ")}`
      : publicId ? "" : "No game characters linked yet. The desktop app links yours when it sees you in game.";
    // Board standing follows the leaderboard gate; the server sends none while the owner can't read the boards.
    for (const panel of ["interlink", "sim", "eggheist"]) {
      profileOverview.querySelector(`[data-overview-panel="${panel}"]`).hidden = !overview.leaderboards;
    }
    if (overview.leaderboards) {
      renderInterlink(overview.leaderboards);
      renderSim(overview.leaderboards);
      renderEggHeist(overview.leaderboards);
    }
    renderGameStats(overview.gameStats);
    renderCollection(overview.collection, Boolean(publicId));
    renderPhotos(overview.photos, Boolean(publicId));
    applyCardLayout(overview.layout);
    showProfileLink(publicId, overview.profile);
    showBattleHistory(publicId);
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
  const visibility = profilePublicRow.hidden ? {} : { isPublic: profilePublic.checked, findableByName: profileFindable.checked, showPresence: profileShowPresence.checked, listedInSearch: profileListedInSearch.checked };
  try {
    const response = await apiFetch("/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName, bio, ...visibility }),
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
  for (const key of ["profile", "view", "auth", "history"]) next.delete(key);
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
            link.append(element("strong", "", result.displayName));
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
  const id = publicId || profile?.publicId || "";
  const url = share.querySelector("[data-profile-share-url]");
  const note = share.querySelector("[data-profile-share-note]");
  share.hidden = !PROFILE_VIEW;
  share.querySelector("[data-profile-copy]").hidden = !id;
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
  void loadProfileDirectory();
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
    cardGrid.append(panel);
  }
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
  tools.append(handle,
    button("Move up", "↑", () => { draftCards = window.AniiProfileCards.moveCard(draftCards, card.id, { step: -1 }); renderDraft(card.id, "up"); }, index === 0),
    button("Move down", "↓", () => { draftCards = window.AniiProfileCards.moveCard(draftCards, card.id, { step: 1 }); renderDraft(card.id, "down"); }, index === count - 1),
    toggle);
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
  return run.boss?.name || "Holo-Battle Interlink";
}
function historyNumbers(run) {
  const parts = [];
  if (run.mode === "interlink" && run.score != null) parts.push(`${numberFormat.format(run.score)} pts`);
  if (run.mode === "eggheist" && run.score != null) parts.push(`${numberFormat.format(run.score)} pts`);
  if (run.stars != null && run.mode === "interlink") parts.push(`★ ${run.stars}`);
  if (run.clearTimeS != null) parts.push(run.cleared ? `cleared in ${clockTime(run.clearTimeS)}` : run.mode === "interlink" ? "no clear" : clockTime(run.clearTimeS));
  if (run.floors != null) parts.push(`${run.floors} floors`);
  return parts.join(" · ");
}
function historyChips(run) {
  const chips = [];
  const chip = (cls, text, title = "") => { const node = element("span", `history-chip ${cls}`, text); if (title) node.title = title; chips.push(node); };
  if (run.check === "verified") chip("is-verified", "Verified", "Checked: the site read this run's full screenshots again and they agree.");
  if (run.check === "pending") chip("is-pending", "Pending", "Waiting for a check against this run's full screenshots.");
  if (run.newBests?.length) chip("is-best", "New best", "This run beat one of the player's bests when it was captured.");
  if (run.credited) chip("is-credited", "Teammate's capture", "A teammate's aLogs captured this run with this player in the party.");
  if (run.hidden) chip("is-hidden", "Hidden", "Hidden from the boards: only you see it here.");
  return chips;
}
// a player's lead Aniimo from extra.lineup (aLogs' Party screen: [{ slot, name, ai, self, aniimo, aniimoLevel }], or
// { lead: { name, level } }): the entry with the player's name, else the same slot
function lineupLead(run, player, index) {
  const lineup = Array.isArray(run.lineup) ? run.lineup : [];
  const named = player?.name && lineup.find((item) => String(item?.name || "").toLowerCase() === String(player.name).toLowerCase());
  const entry = named || lineup.find((item) => Number(item?.slot) === index + 1) || lineup[index];
  const lead = entry?.lead ?? entry?.aniimo ?? null;
  const name = typeof lead === "string" ? lead : lead?.name || "";
  const level = (typeof lead === "object" && lead ? lead.level : null) ?? entry?.aniimoLevel ?? entry?.level;
  return name ? `${name}${Number.isInteger(level) ? ` Lv ${level}` : ""}` : "";
}
function historyParty(run) {
  let players = (run.players || []).filter((player) => player && (player.name || player.avgDps != null));
  // no Battle Data read: the party from the Party screen (names only)
  if (!players.length && Array.isArray(run.lineup)) players = run.lineup.filter((item) => item?.name).map(({ name, ai, self }) => ({ name, ai, self }));
  if (!players.length) return element("p", "history-empty", "No party read for this run.");
  const table = element("table", "history-party");
  const head = element("tr");
  for (const label of ["", "Player", "Lead", "Avg DPS", "BREAK", "Damage Taken", "Healing"]) head.append(element("th", "", label));
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
    const number = (value) => element("td", "history-number", value == null ? "–" : numberFormat.format(value));
    row.append(element("td", "history-slot", `${index + 1}P`), who, element("td", "", lineupLead(run, player, index) || "–"),
      number(player.avgDps), number(player.breakValue), number(player.damageTaken), number(player.heal));
    body.append(row);
  });
  table.append(thead, body);
  const wrap = element("div", "history-party-wrap");
  wrap.append(table);
  return wrap;
}
function historyProof(run) {
  const box = element("div", "history-proof");
  if (run.proofPrunedAt) {
    box.append(element("p", "history-empty", "The pictures of this run are no longer kept (it isn't a best; pictures of other runs are kept 90 days). Its numbers stay."));
    return box;
  }
  const shots = [["", "Result", run.hasEvidence, "full"], ["battle", "Battle Data", run.hasBattleEvidence, "battle_full"]].filter(([, , has]) => has);
  if (!shots.length) { box.append(element("p", "history-empty", "No pictures with this run.")); return box; }
  for (const [shot, label, , full] of shots) {
    const base = `${API_URL}/leaderboard/submissions/${encodeURIComponent(run.submissionId)}/evidence`;
    const link = element("a", "history-shot");
    const fullKey = full === "full" ? "evidence" : "battle";
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
  details.addEventListener("toggle", () => {
    if (!details.open || details.dataset.filled) return;
    details.dataset.filled = "1";
    const body = element("div", "history-body");
    body.append(historyParty(run), historyProof(run));
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
    const more = element("a", "history-see-all", "See all");
    more.href = historyLink(true);
    body.replaceChildren(list, more);
  } catch {
    body.replaceChildren(element("p", "", "Battle History couldn't be loaded right now."));
  }
}
// the full view: filters, a page at a time
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
    if (page.filters && !historyFull.dataset.filtersReady) {
      historyFull.dataset.filtersReady = "1";
      const fill = (name, items) => {
        const select = historyFull.querySelector(`[data-history-filter="${name}"]`);
        select.append(...items.map(([value, label]) => { const option = element("option", "", label); option.value = value; return option; }));
        select.closest("label").hidden = items.length < 2;
      };
      const modeNames = { interlink: "Holo-Battle Interlink", sim: "Holo-Battle Sim", eggheist: "Egg Heist" };
      fill("mode", page.filters.modes.map((row) => [row.value, `${modeNames[row.value] || row.value} (${row.count})`]));
      fill("boss", page.filters.bosses.map((row) => [row.id, `${row.name || row.id} (${row.count})`]));
      fill("cycle", page.filters.weeks.map((row) => [row.value, `${weekLabel(row) || `Week ${row.value}`} (${row.count})`]));
    }
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
    if (!historyFull.dataset.started) { historyFull.dataset.started = "1"; void loadHistoryPage(true); }
  } else void loadHistoryCard();
}
if (HISTORY_VIEW) {
  document.body.classList.add("profile-history-view");
  for (const select of historyFull.querySelectorAll("[data-history-filter]")) select.addEventListener("change", () => { historyNext = null; void loadHistoryPage(true); });
  historyFull.querySelector("[data-history-more]").addEventListener("click", () => void loadHistoryPage(false));
}

// ---------------------------------------------------------------- Online now and Recently joined
// Public profiles only, by the name they show publicly; players online with a private profile are just a number.
async function loadProfileDirectory() {
  const box = profileOverview.querySelector("[data-profile-directory]");
  const link = (row) => {
    const anchor = element("a", "profile-directory-player");
    anchor.href = profileHref({ profile: row.publicId });
    anchor.append(element("strong", "", row.name));
    return anchor;
  };
  try {
    const response = await apiFetch("/profiles/directory");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { recent = [], online = {} } = await response.json();
    const players = (online.players || []).map((row) => {
      const item = element("li");
      const anchor = link(row);
      const state = element("span", "profile-presence", row.state === "afk" ? "AFK" : "Online");
      state.dataset.state = row.state;
      anchor.append(state);
      item.append(anchor);
      return item;
    });
    box.querySelector("[data-directory-online]").replaceChildren(...(players.length ? players
      : [element("li", "profile-directory-empty", "No public profiles online right now.")]));
    const others = Number(online.others || 0);
    box.querySelector("[data-directory-others]").textContent = others
      ? `${players.length ? "And " : ""}${others} ${others === 1 ? "player" : "players"} online with a private profile.` : "";
    box.querySelector("[data-directory-recent]").replaceChildren(...(recent.length ? recent.map((row) => {
      const item = element("li");
      const anchor = link(row);
      if (row.joinedAt) anchor.append(element("small", "", `joined ${new Date(row.joinedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`));
      item.append(anchor);
      return item;
    }) : [element("li", "profile-directory-empty", "No public profiles yet.")]));
    box.hidden = false;
  } catch {
    box.hidden = true;
  }
}
if (PROFILE_VIEW && !PUBLIC_PROFILE_ID && !HISTORY_VIEW) void loadProfileDirectory();

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
