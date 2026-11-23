// The aniilogs.github.io forwarder's script (scripts/build-github-forwarder.mjs copies it to /forward.js). It sends the
// visitor to the same path, query and #fragment on the site's own domain. A browser keeps saved data per address, so
// the first time, from a page of the site (data-carry), it also takes the site's saved settings along: the site's own
// keys only, never the sign-in token or anything about signing in (carried(), the same rule as public/carry-in.js),
// packed as "carry=j<base64url JSON>" (or "z" + deflate-compressed, when large) at the end of the #fragment, which
// never reaches a server or a Referer. public/carry-in.js on the site stores them where it has nothing saved yet.
// It carries nothing while aLogs' sign-in hand-off is in the #fragment (a later visit carries), and only once:
// "aniilogs-carried" is remembered here after a carry. Over 1 MB the largest keys stay behind (named in the console).
(() => {
  const SITE = "https://aniilogs.app";
  const CAP = 1024 * 1024;                       // characters of the packed carry
  const MAX_DECODED = 2 * 1024 * 1024;           // what public/carry-in.js accepts unpacked
  const FLAG = "aniilogs-carried";
  const script = document.currentScript;

  function carried(key) {
    return typeof key === "string" && key.length <= 200 && /^(?:aniilogs:|minmax-)/u.test(key)
      && !/auth|session|token|secret|passw|handoff|cookie|credential/iu.test(key);
  }

  function base64url(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  }

  const json = (entries) => JSON.stringify({ v: 1, k: Object.fromEntries(entries) });
  const plain = (entries) => `j${base64url(new TextEncoder().encode(json(entries)))}`;
  async function compressed(entries) {
    const stream = new Blob([json(entries)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return `z${base64url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
  }

  function go(payload) {
    let fragment = String(window.location.hash || "").slice(1);
    if (payload) {
      fragment = fragment ? `${fragment}&carry=${payload}` : `carry=${payload}`;
      try { window.localStorage.setItem(FLAG, "1"); } catch { /* it may carry again; the site never overwrites */ }
    }
    window.location.replace(`${SITE}${window.location.pathname}${window.location.search}${fragment ? `#${fragment}` : ""}`);
  }

  function saved() {
    if (!script || !script.hasAttribute("data-carry")) return [];
    if (/(?:^#|&)aniilogs_auth=/u.test(String(window.location.hash || ""))) return [];
    try {
      if (window.localStorage.getItem(FLAG) === "1") return [];
      const entries = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (carried(key)) entries.push([key, window.localStorage.getItem(key)]);
      }
      return entries.filter(([, value]) => typeof value === "string")
        .sort((a, b) => a[0].length + a[1].length - b[0].length - b[1].length);
    } catch {
      return [];
    }
  }

  async function pack(entries) {
    const kept = entries.slice();
    const left = [];
    const zip = typeof CompressionStream === "function";
    for (;;) {
      if (!kept.length) break;
      if (json(kept).length > MAX_DECODED) {     // the site takes at most 2 MB unpacked
        left.push(kept.pop()[0]);
        continue;
      }
      const payload = plain(kept);
      if (payload.length <= CAP) return { payload, left };
      if (zip) {
        const small = await compressed(kept);
        if (small.length <= CAP) return { payload: small, left };
      }
      left.push(kept.pop()[0]);                  // the largest stays behind
    }
    return { payload: "", left };
  }

  const entries = saved();
  if (!entries.length) {
    go("");
    return;
  }
  pack(entries).then(({ payload, left }) => {
    if (left.length) console.info(`AniiLogs: too large to take along, left on this address: ${left.join(", ")}`);
    go(payload);
  }, () => go(""));
})();
