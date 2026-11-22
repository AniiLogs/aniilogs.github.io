// game-audit: n/a the not-found page, no game data
// /404.html's script. GitHub Pages serves that page at every address without a file, so this reads the address:
// a run link (/lb/<code>) goes on to the API's /<code>, /lb/home to the leaderboards, a /lb/ address that can't be a
// run link says so, and anything else stays "Page not found" (the page's own text). short-link.js does the reading.
(() => {
  const shortLink = window.AniilogsShortLink;
  if (!shortLink) return;
  let apiOrigin = "";
  try { apiOrigin = new URL(window.ANIILOGS_CONFIG?.apiUrl, window.location.href).origin; } catch { apiOrigin = window.location.origin; }
  const target = shortLink.resolve(window.location.pathname, apiOrigin);
  if (!target) return;

  const title = document.querySelector("[data-not-found-title]");
  const text = document.querySelector("[data-not-found-text]");
  const actions = document.querySelector("[data-not-found-actions]");
  const loader = document.querySelector("[data-not-found-loader]");
  const link = (href, label, className) => {
    const node = document.createElement("a");
    node.href = href;
    node.textContent = label;
    if (className) node.className = className;
    return node;
  };

  if (target.kind === "bad-link") {
    document.title = "That link isn't right — AniiLogs";
    title.textContent = "That link isn't right.";
    text.textContent = "A run link looks like aniilogs.github.io/lb/ and five letters or numbers.";
    actions.replaceChildren(link("/leaderboard/", "Leaderboards", "primary-button"));
    return;
  }

  const run = target.kind === "link";
  document.title = `${run ? "Opening the run…" : "Opening the leaderboards…"} — AniiLogs`;
  title.textContent = run ? "Opening the run…" : "Opening the leaderboards…";
  text.replaceChildren(link(target.url, "Open it"));
  actions.replaceChildren();
  try { window.AlogsLoader?.create(loader).loop(); } catch { /* the words still say it's opening */ }
  window.location.replace(target.url);
})();
