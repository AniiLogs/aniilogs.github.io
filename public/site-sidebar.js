// The site's own left column (the owner's MySpace model: some parts are the site's and fixed, some are the player's).
// It sits beside the page on the Leaderboards and Profiles pages, outside the profile's own cards (never part of
// Arrange cards). On narrow screens it folds into a one-line strip under the bar ("2 online · 5 joined this week") that
// opens in place. Pages ask for it with <body data-site-sidebar="always"> or "profile" (only on a profile view).
//
// Panels: Online now and Recently joined (GET /api/profiles/directory: public profiles listed by their owners, the
// rest only counted). More site panels join through window.AniiSiteSidebar.addPanel(id, title) -> its body element.
//
// Also window.AniiSite.playerName(text, nameSource): a player's name as they chose to be shown, with a small Discord
// logo when it's their Discord name (Edit profile > Show me by). Every page that shows account names uses it.
(() => {
  const SVG = "http://www.w3.org/2000/svg";
  const DISCORD_PATH = "M19.54 5.34A17.3 17.3 0 0 0 15.22 4l-.53 1.08a15.8 15.8 0 0 0-5.38 0L8.78 4a17.5 17.5 0 0 0-4.33 1.35C1.72 9.39.98 13.33 1.35 17.2a17.6 17.6 0 0 0 5.3 2.68l1.29-1.76a11 11 0 0 1-2.03-.98l.5-.38a12.4 12.4 0 0 0 11.18 0l.5.38c-.65.39-1.33.72-2.03.98l1.29 1.76a17.5 17.5 0 0 0 5.3-2.68c.44-4.48-.75-8.38-3.11-11.86ZM8.52 14.82c-1.04 0-1.9-.96-1.9-2.14s.84-2.14 1.9-2.14c1.07 0 1.92.97 1.9 2.14 0 1.18-.84 2.14-1.9 2.14Zm6.96 0c-1.04 0-1.9-.96-1.9-2.14s.84-2.14 1.9-2.14c1.07 0 1.92.97 1.9 2.14 0 1.18-.83 2.14-1.9 2.14Z";

  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // The Discord logo as an inline SVG (styled by .discord-name-mark; no external image, no style attribute)
  function discordMark() {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "discord-name-mark");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", DISCORD_PATH);
    svg.append(path);
    return svg;
  }

  // A name as its player chose to be shown: plain text, or the Discord logo and their Discord name
  function playerName(text, nameSource = null) {
    const name = element("span", "player-name");
    if (nameSource === "discord") {
      name.classList.add("is-discord");
      name.title = "Their Discord name";
      name.append(discordMark(), element("span", "sr-only", "Discord: "), element("span", "player-name-text", String(text || "")));
      return name;
    }
    name.append(document.createTextNode(String(text || "")));
    return name;
  }
  window.AniiSite = Object.freeze({ playerName, discordMark });

  // ---------------------------------------------------------------- the sidebar
  const want = document.body?.dataset.siteSidebar;
  const params = new URLSearchParams(window.location.search);
  const profileView = params.get("view") === "profile" || params.has("profile");
  const main = document.querySelector("body > main");
  if (!main || !(want === "always" || (want === "profile" && profileView))) return;
  const API_URL = String(window.ANIILOGS_CONFIG?.apiUrl || window.ANIILOGS_CONFIG?.shareApiUrl || "").replace(/\/+$/u, "");
  if (!API_URL) return;

  // the page and its sidebar side by side: [sidebar | main]
  const layout = element("div", "site-layout");
  const sidebar = element("aside", "site-sidebar");
  sidebar.setAttribute("aria-label", "Community");
  const toggle = element("button", "site-sidebar-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "site-sidebar-panels");
  const summary = element("span", "site-sidebar-summary", "Community");
  const chevron = element("span", "site-sidebar-chevron", "⌄");
  chevron.setAttribute("aria-hidden", "true");
  toggle.append(summary, chevron);
  const panels = element("div", "site-sidebar-panels");
  panels.id = "site-sidebar-panels";
  sidebar.append(toggle, panels);
  main.before(layout);
  layout.append(sidebar, main);
  document.body.classList.add("has-site-sidebar");

  // phones: the strip opens and closes the panels in place
  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    sidebar.classList.toggle("is-open", open);
  });

  function addPanel(id, title) {
    const panel = element("section", "site-panel");
    panel.dataset.sitePanel = id;
    const heading = element("h2", "site-panel-title", title);
    heading.id = `site-panel-${id}`;
    panel.setAttribute("aria-labelledby", heading.id);
    const body = element("div", "site-panel-body");
    panel.append(heading, body);
    panels.append(panel);
    return body;
  }
  window.AniiSiteSidebar = Object.freeze({ addPanel, element: sidebar });

  // ---------------------------------------------------------------- Online now and Recently joined
  // Public profiles only, by the name they chose to be shown by; players online with a private profile are a number.
  const onlineBody = addPanel("online", "Online now");
  const recentBody = addPanel("recent", "Recently joined");
  const loading = () => element("p", "site-panel-empty", "Loading…");
  onlineBody.append(loading());
  recentBody.append(loading());

  const link = (row) => {
    const anchor = element("a", "site-player");
    anchor.href = `/?profile=${encodeURIComponent(row.publicId)}`;
    const name = playerName(row.name, row.nameSource);
    name.classList.add("site-player-name");
    anchor.append(name);
    return anchor;
  };
  const list = (items, empty) => {
    if (!items.length) return element("p", "site-panel-empty", empty);
    const ul = element("ul", "site-player-list");
    ul.append(...items.map((anchor) => { const li = element("li"); li.append(anchor); return li; }));
    return ul;
  };
  const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

  async function load() {
    try {
      const response = await fetch(`${API_URL}/profiles/directory`, { credentials: "omit" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { recent = [], online = {}, counts = {} } = await response.json();
      const players = (online.players || []).map((row) => {
        const anchor = link(row);
        // the same Online / AFK pills as the profile header
        const state = element("span", "profile-presence", row.state === "afk" ? "AFK" : "Online");
        state.dataset.state = row.state === "afk" ? "afk" : "online";
        anchor.append(state);
        return anchor;
      });
      const others = Number(online.others || 0);
      const note = others ? element("p", "site-panel-note",
        `${players.length ? "And " : ""}${plural(others, "player", "players")} online who keep their profile out of these lists.`) : null;
      const shown = players.length || !others ? [list(players, "No public profiles online right now.")] : [];
      onlineBody.replaceChildren(...shown, ...(note ? [note] : []));
      recentBody.replaceChildren(list(recent.map((row) => {
        const anchor = link(row);
        if (row.joinedAt) {
          anchor.append(element("small", "site-player-when",
            new Date(row.joinedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })));
        }
        return anchor;
      }), "No public profiles yet."));
      const onlineCount = Number.isFinite(counts.online) ? counts.online : players.length + others;
      const joined = Number(counts.joinedThisWeek);
      if (Number.isFinite(joined)) {
        recentBody.append(element("p", "site-panel-note", `${plural(joined, "player", "players")} joined this week.`));
      }
      summary.textContent = [`${onlineCount} online`, Number.isFinite(joined) ? `${joined} joined this week` : ""].filter(Boolean).join(" · ");
    } catch {
      // the lists can't be read right now: the page goes on without its sidebar
      layout.before(main);
      layout.remove();
      document.body.classList.remove("has-site-sidebar");
    }
  }
  void load();
})();
