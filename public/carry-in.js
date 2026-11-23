// game-audit: n/a moves this browser's saved site settings from the old address, no game data
// The site moved from https://aniilogs.github.io to https://aniilogs.app, and a browser keeps saved data per address.
// The old address's forwarder (scripts/forwarder/forward.js) sends a visitor's saved settings along once, at the end of
// the #fragment: "...&carry=j<base64url JSON>" (or "z" + the same, deflate-compressed, when it is large). This runs
// first on every page, blocking in <head> before theme-shell.js, so a carried theme is in place before the first paint:
//   - it takes "carry=..." off the address at once (history.replaceState), leaving the rest of the #fragment as it was
//     (aLogs' sign-in hand-off, a page's own #anchor);
//   - it only accepts data that came from the old address (document.referrer; a local preview may forward to itself);
//   - it stores a key only when this browser has nothing saved under it here (never over newer data), and only the
//     site's own settings keys: never the sign-in token or anything about signing in (carried() below);
//   - anything malformed or over 2 MB is ignored.
// window.AniilogsCarry: { carried(key), decode(payload) } (decode: the { key: value } map, or null), for the tests.
(() => {
  const MAX_ENCODED = 1536 * 1024;
  const MAX_DECODED = 2 * 1024 * 1024;
  const OLD_ORIGINS = ["https://aniilogs.github.io"];
  const LOCAL = /^(?:127\.0\.0\.1|localhost|\[::1\])$/u;

  // the site's own keys ("aniilogs:..." and the older "minmax-..."), never the sign-in or anything near it; the same
  // rule as forward.js (test/carry.test.js keeps the two alike)
  function carried(key) {
    return typeof key === "string" && key.length <= 200 && /^(?:aniilogs:|minmax-)/u.test(key)
      && !/auth|session|token|secret|passw|handoff|cookie|credential/iu.test(key);
  }

  function bytesOf(base64url) {
    const base64 = base64url.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function read(json) {
    if (typeof json !== "string" || json.length > MAX_DECODED) return null;
    let parsed;
    try { parsed = JSON.parse(json); } catch { return null; }
    if (!parsed || parsed.v !== 1 || !parsed.k || typeof parsed.k !== "object" || Array.isArray(parsed.k)) return null;
    const out = {};
    for (const [key, value] of Object.entries(parsed.k)) {
      if (carried(key) && typeof value === "string") out[key] = value;
    }
    return out;
  }

  // "j..." (plain): the map at once; "z..." (compressed): a promise of it; null when it isn't one
  function decode(payload) {
    const match = /^([jz])([A-Za-z0-9_-]+)$/u.exec(String(payload || ""));
    if (!match || payload.length > MAX_ENCODED) return null;
    let bytes;
    try { bytes = bytesOf(match[2]); } catch { return null; }
    if (match[1] === "j") {
      try { return read(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
    }
    if (typeof DecompressionStream !== "function") return null;
    return (async () => {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_DECODED) { await reader.cancel(); return null; }
        chunks.push(value);
      }
      return read(new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(chunks).arrayBuffer()));
    })().catch(() => null);
  }

  // stores what this browser doesn't have here yet; returns how many it stored
  function store(values) {
    let stored = 0;
    for (const [key, value] of Object.entries(values || {})) {
      try {
        if (window.localStorage.getItem(key) !== null) continue;   // newer data here wins
        window.localStorage.setItem(key, value);
        stored += 1;
      } catch {
        return stored;                                              // no storage, or full: keep what fitted
      }
    }
    return stored;
  }

  window.AniilogsCarry = Object.freeze({ carried, decode });

  const fragment = String(window.location.hash || "").slice(1);
  const found = /(?:^|&)carry=([^&]*)$/u.exec(fragment);
  if (!found) return;
  const rest = fragment.slice(0, found.index);
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`);
  } catch {
    // the address keeps it; nothing reads it
  }
  let from = "";
  try { from = new URL(document.referrer).origin; } catch { from = ""; }
  let fromLocal = false;
  try { fromLocal = LOCAL.test(new URL(from).hostname) && LOCAL.test(window.location.hostname); } catch { fromLocal = false; }
  if (!OLD_ORIGINS.includes(from) && !fromLocal) return;

  const values = decode(found[1]);
  if (!values) return;
  if (typeof values.then !== "function") {
    store(values);
    return;
  }
  // a large carry: unpacked after the page started, so the page opens once more to read it
  values.then((map) => { if (store(map) > 0) window.location.reload(); });
})();
