// game-audit: n/a lists and mounts the guides (damage-guide.js, interlink-guide.js); no game rules of its own
// The Guides page (/guides/): without ?guide= it lists every guide in window.AniilogsGuides as a card; with
// ?guide=<id> it shows that guide (guide-page.js), with a link back to the list. Section links (#guide-<id>) work as
// before. The Aniilog data, when it loads, links every Aniimo a guide names to its page.
(() => {
  "use strict";
  const root = document.querySelector("[data-guides]");
  if (!root) return;
  const body = root.querySelector("[data-guides-body]");
  const title = root.querySelector("[data-guides-title]");
  const lead = root.querySelector("[data-guides-lead]");
  const config = window.ANIILOGS_CONFIG || {};

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  function contentUrl(path) {
    const base = String(config.contentBaseUrl || "").replace(/\/+$/u, "");
    if (!base) return "";
    const url = new URL(`${base}/${path}`, window.location.href);
    if (config.contentRevision) url.searchParams.set("v", config.contentRevision);
    return url.href;
  }

  // The Aniilog's entries, for the Aniimo links; the guides read fine without them.
  async function loadAniilog() {
    const url = contentUrl("data/aniilog_data.json");
    if (!url) return null;
    try {
      const response = await fetch(url);
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  function guideHref(id) {
    return `/guides/?guide=${encodeURIComponent(id)}`;
  }

  function renderList(guides) {
    title.textContent = "Guides";
    lead.textContent = "How Aniimo works under the hood, read from the game's own files. Each section says how sure it is.";
    document.title = "Aniimo Guides · AniiLogs";
    const list = el("div", "guides-list");
    guides.forEach((guide) => {
      const card = el("a", "guides-card");
      card.href = guideHref(guide.id);
      card.append(el("h2", "", guide.title), el("p", "", guide.summary || ""));
      list.append(card);
    });
    body.replaceChildren(list);
  }

  function renderGuide(guide, aniilog) {
    title.textContent = guide.title;
    lead.textContent = "";
    const back = el("a", "guides-back", "All guides");
    back.href = "/guides/";
    lead.append(back);
    document.title = `${guide.title} · Aniimo Guides · AniiLogs`;
    body.replaceChildren(window.AniilogsGuidePage.render({ guide, aniilog }));
  }

  async function start() {
    const guides = Array.isArray(window.AniilogsGuides) ? window.AniilogsGuides : [];
    const id = new URLSearchParams(window.location.search).get("guide");
    const guide = guides.find((item) => item.id === id);
    if (!guide || !window.AniilogsGuidePage) {
      renderList(guides);
      return;
    }
    renderGuide(guide, null);
    // Re-render with the Aniimo links once the Aniilog arrives, keeping the reader's place.
    const aniilog = await loadAniilog();
    if (!aniilog) return;
    const scroll = window.scrollY;
    renderGuide(guide, aniilog);
    window.scrollTo(0, scroll);
  }

  start();
})();
