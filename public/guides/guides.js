// game-audit: n/a lists and mounts the guides (damage-guide.js, interlink-guide.js); no game rules of its own
// The Guides page (/guides/): without ?guide= it lists every guide in window.AniilogsGuides as a card, then the guides
// hosted elsewhere (window.AniilogsLinkedGuides, linked-guides.js), with ended event guides under Archived; with
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

  // The end of an event guide as the visitor's local month and day.
  function endDate(guide) {
    return new Date(guide.ends).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function group(heading, line, cards) {
    const section = el("section", "guides-group");
    const list = el("div", "guides-list");
    list.append(...cards);
    section.append(el("h2", "guides-group-title", heading), el("p", "guides-group-line", line), list);
    return section;
  }

  // A guide hosted elsewhere: the card opens that guide itself in a new tab.
  function linkedCard(guide, archived) {
    const card = el("a", archived ? "guides-card is-linked is-archived" : "guides-card is-linked");
    card.href = guide.url;
    card.target = "_blank";
    card.rel = "noopener";
    // The event pill comes first so that, when it wraps, the host line still sits at the bottom like its neighbours'.
    const foot = el("div", "guides-card-foot");
    if (guide.ends) {
      foot.append(el("span", "guides-event", archived ? `Event ended ${endDate(guide)}` : `Event · ends ${endDate(guide)}`));
    }
    foot.append(el("span", "guides-card-host", `${guide.host} ↗`));
    card.append(el("h2", "", guide.title), el("p", "", guide.summary || ""), foot);
    return card;
  }

  function renderList(guides) {
    title.textContent = "Guides";
    lead.textContent = "Guides by AniiLogs and by sargeeva.";
    document.title = "Aniimo Guides · AniiLogs";
    const own = guides.map((guide) => {
      const card = el("a", "guides-card");
      card.href = guideHref(guide.id);
      card.append(el("h2", "", guide.title), el("p", "", guide.summary || ""));
      return card;
    });
    const groups = [group("AniiLogs", "How Aniimo works under the hood, read from the game's own files. Each section says how sure it is.", own)];
    const linked = window.AniilogsLinkedGuides;
    if (linked && Array.isArray(linked.guides)) {
      const now = Date.now();
      const archived = linked.guides.filter((guide) => linked.isArchived(guide, now));
      const current = linked.guides.filter((guide) => !archived.includes(guide));
      if (current.length) {
        groups.push(group("By sargeeva", "Planners, loot tables and event guides on sargeeva.github.io. Each card opens that guide in a new tab.",
          current.map((guide) => linkedCard(guide, false))));
      }
      if (archived.length) {
        groups.push(group("Archived", "Guides for events that have ended.", archived.map((guide) => linkedCard(guide, true))));
      }
    }
    body.replaceChildren(...groups);
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
