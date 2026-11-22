// game-audit: n/a short links to board placements, no game data
// The site's own short link for a board placement: aniilogs.github.io/lb/<code>. GitHub Pages runs no code, so the
// address has no file: Pages answers it with /404.html, whose script (/not-found.js) reads the path here and goes on
// to the API's /<code> (which sends a person to the run on the boards). /lb/home opens the leaderboards, and
// /lb/interlink, /lb/sim and /lb/egg one board each.
// Not on aniilogs.github.io (a local preview, the API's host) there's no /404.html behind /lb/, so base() is "" and the
// link button keeps handing out the API's own /<code> link. window.AniilogsShortLink:
//   resolve(pathname, apiOrigin): { kind: "link", code, url } | { kind: "boards", url } | { kind: "bad-link" } | null
//   base(location): "https://aniilogs.github.io/lb" on aniilogs.github.io, else ""
(() => {
  const CODE = /^[23456789abcdefghjkmnpqrstuvwxyz]{5}$/u;   // the API's PLACEMENT_CODE (src/placement-links.js)
  const HOST = "aniilogs.github.io";
  // /lb/<name>: the boards page, on one board's default view (leaderboard.js readUrl: ?mode= alone picks the mode's
  // first board). Read before codes; a name must never fit CODE, or it would hide a real link.
  const NAMES = Object.freeze({
    "": "/leaderboard/",
    home: "/leaderboard/",
    interlink: "/leaderboard/?mode=interlink",
    sim: "/leaderboard/?mode=sim",
    egg: "/leaderboard/?mode=eggheist",
  });

  function resolve(pathname, apiOrigin) {
    const match = /^\/lb(?:\/([^/]*))?\/?$/iu.exec(String(pathname || ""));
    if (!match) return /^\/lb\//iu.test(String(pathname || "")) ? { kind: "bad-link" } : null;
    const part = String(match[1] || "").toLowerCase();
    if (Object.hasOwn(NAMES, part)) return { kind: "boards", url: NAMES[part] };
    if (!CODE.test(part)) return { kind: "bad-link" };
    return { kind: "link", code: part, url: `${String(apiOrigin || "").replace(/\/+$/u, "")}/${part}` };
  }

  function base(location) {
    return String(location?.hostname || "").toLowerCase() === HOST ? `https://${HOST}/lb` : "";
  }

  window.AniilogsShortLink = Object.freeze({ resolve, base, names: Object.keys(NAMES).filter(Boolean) });
})();
