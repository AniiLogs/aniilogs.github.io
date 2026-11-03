// "Take me there": the small link put next to an Aniimo wherever the site names one (Team Builder, 1v1, the Guide,
// leaderboard teams, profiles, the map and the Aniilog itself). Every Aniimo has its own address,
// /explorer/?aniimo=<form id> (the form id the Aniilog, Team Builder and 1v1 already key everything by), so the link is
// a real <a href>: middle-click, new tab, copy link and a shared or reloaded address all work. A page that only knows
// a name (a leaderboard team read from a result screen) links /explorer/?aniimo=<name>; the Aniilog finds that
// Aniimo and swaps the name for its id in the address.
// Inside the explorer an ordinary click opens the page in place through the navigator the explorer registers
// (one Back step), instead of reloading. Clicking the link never also clicks the card, slot or picker row around it.
(() => {
  "use strict";

  const PAGE_PATH = "/explorer/";
  const STYLE_ID = "aniimo-link-style";
  const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>';
  // Theme colours come from theme-shell.js (--accent, --accent-rgb, --line), so it follows every theme, light or dark.
  const CSS = `
.aniimo-link {
  display: inline-flex; flex: none; align-items: center; justify-content: center;
  width: 20px; height: 20px; margin-inline-start: 4px; padding: 0; border-radius: 6px;
  border: 1px solid rgba(var(--accent-rgb, 98, 217, 179), 0.42);
  background: rgba(var(--accent-rgb, 98, 217, 179), 0.08);
  color: var(--accent, #62d9b3); line-height: 0; vertical-align: middle; text-decoration: none; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
}
.aniimo-link svg { width: 12px; height: 12px; }
.aniimo-link:hover { background: rgba(var(--accent-rgb, 98, 217, 179), 0.22); border-color: var(--accent, #62d9b3); }
.aniimo-link:active { transform: scale(0.92); }
.aniimo-link:focus-visible { outline: 2px solid var(--accent, #62d9b3); outline-offset: 2px; }
.aniimo-link--corner { position: absolute; top: 6px; right: 6px; z-index: 2; margin: 0; }
.aniimo-link-host { position: relative; display: grid; min-width: 0; }
.aniimo-link-inline { display: inline-flex; align-items: center; gap: 2px; }
.aniimo-picker-option .aniimo-link { float: right; margin-block-start: -1px; }
@media (pointer: coarse) { .aniimo-link { width: 26px; height: 26px; } .aniimo-link svg { width: 14px; height: 14px; } }
@media (prefers-reduced-motion: reduce) { .aniimo-link { transition: none; } }
`;

  let navigator = null;

  // The address of an Aniimo's page: its form id, or a name the Aniilog resolves. "" when there is neither.
  function url(id) {
    const key = String(id ?? "").replace(/^aniimo:/u, "").trim();
    return key ? `${PAGE_PATH}?aniimo=${encodeURIComponent(key)}` : "";
  }

  function ensureStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }

  // The link itself: create(id, name[, { corner, className }]). Returns null without an id or a name to link.
  function create(id, name = "", { corner = false, className = "" } = {}) {
    const href = url(id || name);
    if (!href) return null;
    ensureStyle();
    const label = `Open ${String(name || "this Aniimo").trim()} in the Aniilog`;
    const link = document.createElement("a");
    link.className = ["aniimo-link", corner ? "aniimo-link--corner" : "", className].filter(Boolean).join(" ");
    link.href = href;
    link.title = label;
    link.setAttribute("aria-label", label);
    link.dataset.aniimoLink = String(id || name);
    link.innerHTML = ICON;
    // Pickers choose on mousedown and cards act on click/keys: the link keeps all of those to itself.
    link.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      if (event.button === 0) event.preventDefault();   // keeps focus in an open picker so its list stays put
    });
    link.addEventListener("pointerdown", (event) => event.stopPropagation());
    link.addEventListener("keydown", (event) => event.stopPropagation());
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!navigator || window.location.pathname !== PAGE_PATH) return;   // another page: the browser follows the link
      event.preventDefault();
      navigator(String(id || name));
    });
    return link;
  }

  // Puts the link on a card or button that is itself clickable (an <a> can't sit inside a <button>): the button
  // and the link share a wrapper and the link sits in the wrapper's corner. Returns the wrapper.
  function wrapCorner(control, id, name) {
    const link = create(id, name, { corner: true });
    if (!link) return control;
    const wrap = document.createElement("div");
    wrap.className = "aniimo-link-host";
    control.replaceWith?.(wrap);
    wrap.append(control, link);
    return wrap;
  }

  // A button or name followed by its link, kept together on one line. Returns the pair (or the control alone).
  function inline(control, id, name) {
    const link = create(id, name);
    if (!link) return control;
    const pair = document.createElement("span");
    pair.className = "aniimo-link-inline";
    pair.append(control, link);
    return pair;
  }

  // The explorer registers how it opens an Aniimo's page in place (with a history entry).
  function setNavigator(open) {
    navigator = typeof open === "function" ? open : null;
  }

  window.AniilogsAniimoLink = Object.freeze({ url, create, inline, wrapCorner, setNavigator, PAGE_PATH });
})();
