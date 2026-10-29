(() => {
  "use strict";

  // The Try-Hard Guide page (a Team Builder tab): the text from damage-guide.js (window.AniilogsGuide) laid out with
  // a table of contents, a link for every section (#guide-<id>, also usable in a shared link), "Back to contents"
  // after each section and, on desktop, contents that stay beside the text and mark the section being read.
  // Team Builder mounts it with render().
  const BASIS_LABELS = Object.freeze({
    exact: ["From the game files", "Read straight from the game's scripts or tables."],
    "by-name": ["Not verified: matched by name", "The formula input is matched to a game stat by its name; the code that passes it in runs on the game's server. Not yet checked in the game."],
    inferred: ["Not verified: inferred", "A reasoned reading of the game data, not something the files state outright. Not yet checked in the game."],
    text: ["From the game text", "Taken from the game's own skill text rather than its effect data."],
  });
  const SECTION_PREFIX = "guide-";

  function el(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== "") node.textContent = text;
    return node;
  }

  function scrollToId(id, focus) {
    const target = document.getElementById(id);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (focus) target.focus({ preventScroll: true });
    try {
      const url = new URL(window.location.href);
      url.hash = id;
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // The link still scrolls; only the address bar doesn't update.
    }
  }

  function basisBadge(basis) {
    const [label, detail] = BASIS_LABELS[basis] || [basis, ""];
    const badge = el("span", `guide-basis is-${basis}`, label);
    if (detail) badge.title = detail;
    return badge;
  }

  function renderTable(table) {
    const wrap = el("div", "guide-table-wrap");
    const node = el("table", "guide-table");
    const head = el("tr");
    table.columns.forEach((column) => head.append(el("th", "", column)));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    table.rows.forEach((row) => {
      const line = el("tr");
      row.forEach((cell, index) => line.append(el(index === 0 ? "th" : "td", "", String(cell))));
      tbody.append(line);
    });
    node.append(thead, tbody);
    wrap.append(node);
    return wrap;
  }

  function renderContents(sections, compact) {
    const nav = el(compact ? "details" : "nav", "guide-toc");
    nav.id = compact ? "guide-contents" : "guide-contents-side";
    nav.tabIndex = -1;
    if (compact) nav.open = true;
    const title = el(compact ? "summary" : "h2", "guide-toc-title", "Contents");
    const list = el("ol");
    sections.forEach((section) => {
      const item = el("li");
      const link = el("a", "", section.title);
      link.href = `#${SECTION_PREFIX}${section.id}`;
      link.dataset.guideSection = section.id;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        scrollToId(`${SECTION_PREFIX}${section.id}`, true);
      });
      item.append(link);
      list.append(item);
    });
    nav.append(title, list);
    return nav;
  }

  function renderSection(section) {
    const node = el("section", "guide-section");
    node.id = `${SECTION_PREFIX}${section.id}`;
    node.tabIndex = -1;
    const head = el("header", "guide-section-head");
    const title = el("h2", "", section.title);
    const anchor = el("a", "guide-anchor", "#");
    anchor.href = `#${SECTION_PREFIX}${section.id}`;
    anchor.setAttribute("aria-label", `Link to ${section.title}`);
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      scrollToId(node.id, false);
    });
    title.append(" ", anchor);
    head.append(title, basisBadge(section.basis));
    node.append(head);
    (section.paragraphs || []).forEach((text) => node.append(el("p", "", text)));
    if (section.table?.rows?.length) node.append(renderTable(section.table));
    // Open questions to test in the game, as a checklist.
    if (section.tests?.length) {
      const list = el("ul", "guide-tests");
      section.tests.forEach((test) => {
        const item = el("li");
        item.id = `${SECTION_PREFIX}test-${test.id}`;
        item.append(el("span", "guide-test-box", ""), el("span", "", test.text));
        list.append(item);
      });
      node.append(list);
    }
    if (section.note) node.append(el("p", "guide-note", section.note));
    const back = el("a", "guide-back", "Back to contents");
    back.href = "#guide-contents";
    back.addEventListener("click", (event) => {
      event.preventDefault();
      // Desktop shows the side contents; phones the fold-out list at the top.
      const side = document.getElementById("guide-contents-side");
      scrollToId(side && side.getClientRects().length && getComputedStyle(side).display !== "none" ? "guide-contents-side" : "guide-contents", true);
    });
    node.append(back);
    return node;
  }

  // Marks the contents entry of the section being read (desktop contents).
  function watchCurrentSection(root) {
    if (!("IntersectionObserver" in window)) return;
    const links = new Map([...root.querySelectorAll(".guide-toc a[data-guide-section]")].map((link) => [`${SECTION_PREFIX}${link.dataset.guideSection}`, link]));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach((link, id) => link.toggleAttribute("aria-current", id === visible.target.id));
    }, { rootMargin: "-15% 0px -70% 0px" });
    root.querySelectorAll(".guide-section").forEach((section) => observer.observe(section));
  }

  function render() {
    const guide = window.AniilogsGuide;
    const root = el("div", "guide-page");
    if (!guide?.sections?.length) {
      root.append(el("p", "duel-note", "The guide isn't available right now."));
      return root;
    }
    const intro = el("p", "guide-intro", "How damage works in Aniimo, in plain words: what each kind of boost does, what stacks with what, and where your next point of ATK or potential does the most. Each section says how sure it is.");
    const layout = el("div", "guide-layout");
    const contents = renderContents(guide.sections, false);
    const article = el("article", "guide-article");
    article.append(intro, renderContents(guide.sections, true), ...guide.sections.map(renderSection));
    layout.append(contents, article);
    root.append(layout);
    window.setTimeout(() => watchCurrentSection(root), 0);
    // A shared link to a section opens on it.
    const hash = decodeURIComponent(window.location.hash.replace(/^#/u, ""));
    if (hash.startsWith(SECTION_PREFIX)) window.setTimeout(() => scrollToId(hash, false), 60);
    return root;
  }

  window.AniilogsGuidePage = Object.freeze({ render, SECTION_PREFIX });
})();
