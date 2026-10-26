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
const profilePublic = document.querySelector("[data-profile-public]");
const profilePublicRow = document.querySelector("[data-profile-public-row]");
const profilePublicLink = document.querySelector("[data-profile-public-link]");
// /?profile=<id> shows someone's public profile (read-only) in the profile section.
const PUBLIC_PROFILE_ID = /^[A-Za-z0-9]{8,24}$/u.test(new URLSearchParams(window.location.search).get("profile") || "")
  ? new URLSearchParams(window.location.search).get("profile")
  : "";
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

function showSignedOut(message = "Sign in to sync progress. Profiles are private unless their owner makes them public.") {
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
  profileOverview.hidden = !PUBLIC_PROFILE_ID;
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
  status.textContent = `Signed in as ${name}. Your profile is private by default.`;
  profilePublicRow.hidden = false;
  void loadPrivateProfile(name);
  if (!PUBLIC_PROFILE_ID) void loadProfileOverview();
}

function showVisibility(profile) {
  profilePublic.checked = Boolean(profile.isPublic);
  profileStatus.textContent = profile.isPublic ? "Public · anyone with the link can see it" : "Private · visible only to you";
  profilePublicLink.hidden = !(profile.isPublic && profile.publicId);
  if (profile.isPublic && profile.publicId) {
    const link = element("a", "", `${window.location.origin}/?profile=${profile.publicId}`);
    link.href = `/?profile=${profile.publicId}#my-profile`;
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

function renderEggHeist(boards) {
  const body = overviewBody("eggheist");
  const rows = (boards.eggheist_season || []).map((entry) => {
    const rank = entry.seasonRank?.name || (entry.seasonRank ? `Tier ${entry.seasonRank.tier}` : "Unranked");
    return standingRow(
      entry.cycle ? `${entry.cycle} · ${rank}` : rank,
      entry,
      "eggheist_season",
      [
        entry.score != null ? `${numberFormat.format(entry.score)} rank points` : "",
        entry.stars != null && entry.seasonRank?.tier === 7 ? `${numberFormat.format(entry.stars)} ★` : "",
      ],
    );
  });
  if (!rows.length) body.replaceChildren(element("p", "", "No Egg Heist season rank yet."));
  else body.replaceChildren(standingList("Season standing", rows));
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
    ? progressRow("Lumens collected", lumens.collected, lumens.total)
    : progressRow("Lumen sources collected", lumens.sources || 0, lumens.sourceTotal);
  const note = element("p", "", publicView ? "Counted from the AniiLogs map checklist and desktop app. " : "Counted from your map checklist and the desktop app. ");
  const mapLink = element("a", "profile-position", "Open the map");
  mapLink.href = "/explorer/";
  note.append(mapLink);
  overviewBody("collection").replaceChildren(
    element("h4", "", "Aniilog"),
    rowList(aniilogRows),
    element("h4", "", "Lumens"),
    rowList([lumenRow]),
    element("h4", "", "Map"),
    rowList([progressRow("Pins collected", pins.collected || 0, null)]),
    note,
  );
}

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
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const overview = await response.json();
    const avatar = profileOverview.querySelector("[data-overview-avatar]");
    avatar.hidden = !overview.profile?.avatarUrl;
    if (overview.profile?.avatarUrl) avatar.src = overview.profile.avatarUrl;
    profileOverview.querySelector("[data-overview-name]").textContent = overview.profile?.displayName || "My profile";
    profileOverview.querySelector("[data-overview-visibility]").textContent = publicId ? "Public profile"
      : overview.profile?.isPublic ? "Public · anyone with your link can see this" : "Private · only you can see this";
    profileOverview.querySelector("[data-overview-bio]").textContent = overview.profile?.bio || "";
    const characters = (overview.characters || []).map((character) => character.name || `UID ${character.gameUid}`);
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
    renderCollection(overview.collection, Boolean(publicId));
    overviewStatus.textContent = overview.leaderboards ? "" : "Leaderboard standing appears here once leaderboards open.";
    // The section was hidden when the page loaded, so a #my-profile link could not land on it then.
    if (window.location.hash === "#my-profile") profileOverview.scrollIntoView({ behavior: "instant" });
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
  const visibility = profilePublicRow.hidden ? {} : { isPublic: profilePublic.checked };
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
    if (!profileOverview.hidden && !PUBLIC_PROFILE_ID) void loadProfileOverview();
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
