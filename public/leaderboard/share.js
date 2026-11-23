// game-audit: n/a share links to board placements, no game data
// A placement's short link (the API's /api/links, src/placement-links.js) and the Solo / Duo / Trio tag, for the boards
// and the run viewer. window.AniilogsShare:
//   button({ run, ladder, player, code }): a small link button. A click asks the API for the placement's link (made the
//     first time), copies it and says "Link copied"; code: a link already known (a page opened from one).
//     On aniilogs.github.io the copied link is the site's own aniilogs.github.io/lb/<code> (short-link.js, opened by
//     /404.html), so it doesn't name the API's host; elsewhere, or without short-link.js, it's the API's /<code> link.
//   tag(realPlayers): "Solo", "Duo" or "Trio" when the run had bots in the team (the API's realPlayers), else null.
(() => {
  const siteConfig = window.ANIILOGS_CONFIG || {};
  const API_URL = String(siteConfig.apiUrl || siteConfig.shareApiUrl || "").replace(/\/+$/u, "");
  const ONE_PLAYER = new Set(["dps", "break", "heal"]);
  const CODE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u;
  const TAGS = Object.freeze({
    1: { text: "Solo", title: "One player; bots filled the other places. Places are the same for everyone." },
    2: { text: "Duo", title: "Two players; bots filled the other places. Places are the same for everyone." },
    3: { text: "Trio", title: "Three players; a bot filled the last place. Places are the same for everyone." },
  });
  const known = new Map();                           // "<run>|<ladder>|<player>" -> link, for this page

  function tag(realPlayers) {
    const info = TAGS[realPlayers];
    if (!info) return null;
    const node = document.createElement("span");
    node.className = "lb-party-tag";
    node.textContent = info.text;
    node.title = info.title;
    return node;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");   // older browsers, and pages without clipboard access
      area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
      document.body.append(area); area.select();
      let done = false;
      try { done = document.execCommand("copy"); } catch { done = false; }
      area.remove();
      return done;
    }
  }

  // "https://aniilogs.github.io/lb" on aniilogs.github.io (short-link.js), else "": the API's own link
  const shortBase = () => { try { return window.AniilogsShortLink?.base(window.location) || ""; } catch { return ""; } };

  // the site's own link domain (app-config.js linkOrigin), which shows the card in Discord and has no "dev" in it
  const linkBase = () => { try { return String(window.ANIILOGS_CONFIG?.linkOrigin || "").replace(/\/+$/u, ""); } catch { return ""; } };

  async function linkFor(target) {
    if (target.code && linkBase()) return `${linkBase()}/${target.code}`;
    if (target.code) return shortBase() ? `${shortBase()}/${target.code}` : `${new URL(API_URL).origin}/${target.code}`;
    const key = `${target.run}|${target.ladder}|${target.player || ""}`;
    if (!known.has(key)) {
      known.set(key, (async () => {
        const response = await fetch(`${API_URL}/links`, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
          body: JSON.stringify({ run: target.run, ladder: target.ladder, ...(target.player ? { player: target.player } : {}) }) });
        if (!response.ok) throw new Error(response.status === 404 ? "gone" : "failed");
        const { code, url } = await response.json();
        if (linkBase() && CODE.test(String(code || ""))) return `${linkBase()}/${code}`;
        return shortBase() && CODE.test(String(code || "")) ? `${shortBase()}/${code}` : url;
      })().catch((error) => { known.delete(key); throw error; }));
    }
    return known.get(key);
  }

  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M10 14a4.5 4.5 0 0 0 6.4 0l3.2-3.2a4.5 4.5 0 0 0-6.4-6.4L11.6 6M14 10a4.5 4.5 0 0 0-6.4 0l-3.2 3.2a4.5 4.5 0 0 0 6.4 6.4l1.6-1.6"/></svg>';
  // target: { run, ladder, player?, code? }; null when there's nothing to link to
  function button(target) {
    if (!API_URL || !target) return null;
    const code = CODE.test(String(target.code || "")) ? target.code : null;
    const run = /^[A-Za-z0-9_-]{8,40}$/u.test(String(target.run || "")) ? target.run : null;
    const ladder = String(target.ladder || "score");
    if (!code && (!run || (ONE_PLAYER.has(ladder) && !target.player))) return null;
    const node = document.createElement("button");
    node.type = "button";
    node.className = "lb-link";
    node.title = "Copy a link to this place on the board";
    node.setAttribute("aria-label", "Copy a link to this place on the board");
    node.innerHTML = ICON;
    const label = document.createElement("span");
    label.className = "lb-link-label";
    label.setAttribute("aria-live", "polite");
    node.append(label);
    let timer = 0;
    const say = (text, state) => {
      window.clearTimeout(timer);
      label.textContent = text;
      node.dataset.state = state;
      if (state !== "busy") timer = window.setTimeout(() => { label.textContent = ""; delete node.dataset.state; }, state === "manual" ? 15000 : 2400);
    };
    node.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (node.dataset.state === "busy") return;
      // the Eklue loader while the link is made (the first time only; it's quick after)
      const spinner = document.createElement("span");
      spinner.className = "lb-link-loader";
      say("", "busy");
      node.prepend(spinner);
      try { window.AlogsLoader?.create(spinner).loop(); } catch { /* the label still says it's working */ }
      try {
        const url = await linkFor({ run, ladder, player: target.player, code });
        spinner.remove();
        if (await copy(url)) say("Link copied", "done");
        else say(url, "manual");                         // no clipboard here: the link itself, to copy by hand
      } catch (error) {
        spinner.remove();
        say(error.message === "gone" ? "No link for this run" : "Couldn't make the link", "failed");
      }
    });
    return node;
  }

  window.AniilogsShare = Object.freeze({ button, tag });
})();
