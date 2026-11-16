// Which Aniimo each player led with, read from the run's Party screen picture: every card shows its lead as a head
// portrait, and a renamed Aniimo's name says nothing about its species (the card prints the nickname), so the picture
// is what counts. The same match aLogs makes on the live screen (its icons.py / live.py), on the stored proof:
// each card's team row is found by a skill badge, the lead's portrait sits a fixed step from it, and that part of the
// picture is compared with every head portrait of the game (the pack: /api/content/.../party-heads/), faded into the
// card the way the game fades it. An answer counts only when it is clearly ahead of the next Aniimo.
// window.AniilogsPartyPortraits: core (pure, on pixel arrays: the tests run it) and, in a browser, leads(blob, mode).
(() => {
  "use strict";

  // The Party screen as the game lays it out, in fractions of the 16:9 UI's width (x) and the picture's height (y):
  // each card's left and top, the team row's first portrait from them, and the lead's portrait from that one
  // (aLogs: live.py PARTY_CARDS, EGG_PARTY_CARDS, TEAM_*, LEAD_*; measured on saved screens).
  const LAYOUTS = Object.freeze({
    interlink: [[0.33, 0.548], [0.598, 0.563], [0.116, 0.6], [0.842, 0.587]],
    eggheist: [[0.4505, 0.569], [0.162, 0.6236], [0.743, 0.5996]],
  });
  const TEAM_PITCH = 0.0503;                 // one team tile to the next; 240 of the game's own units
  const TEAM_SQUARE = [-0.0345, 0.0472, 0.0405];
  const TEAM_BADGE = [74, 42];               // the skill badge: its centre right of the portrait's, its radius (units)
  const LEAD_OFFSET = [-6, -152];            // the lead portrait's centre from the first team tile's (units)
  const LEAD_PORTRAIT = 256;
  const LEAD_COMPARE = [-90, -100, 86, 90];  // the part compared, around the lead's centre (units)
  const COMPARE_WIDTH = 40;                  // that part shrunk to this many px wide before comparing

  const pyRound = (v) => {                   // Python's round(): halves go to the even number
    const f = Math.floor(v);
    const d = v - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  };

  // A picture part shrunk or grown the way Pillow's BILINEAR does it (a triangle filter as wide as the scale).
  // src: channels interleaved, sw x sh; box [x0, y0, x1, y1] in src px (whole numbers). Returns Float32Array.
  function resample(src, sw, channels, box, dw, dh) {
    const [bx0, by0, bx1, by1] = box;
    const pass = (input, inW, inStart, inLen, outLen, lines, lineStart, horizontal) => {
      const scale = inLen / outLen;
      const support = Math.max(scale, 1);
      const out = new Float32Array((horizontal ? outLen * lines : inW * outLen) * channels);
      for (let o = 0; o < outLen; o += 1) {
        const centre = (o + 0.5) * scale;
        const lo = Math.max(0, Math.floor(centre - support));
        const hi = Math.min(inLen, Math.ceil(centre + support));
        const weights = [];
        let total = 0;
        for (let i = lo; i < hi; i += 1) {
          const w = Math.max(0, 1 - Math.abs((i + 0.5 - centre) / support));
          weights.push(w);
          total += w;
        }
        for (let line = 0; line < lines; line += 1) {
          for (let c = 0; c < channels; c += 1) {
            let sum = 0;
            for (let i = lo; i < hi; i += 1) {
              const at = horizontal
                ? ((lineStart + line) * inW + inStart + i) * channels + c
                : ((inStart + i) * inW + line) * channels + c;
              sum += input[at] * weights[i - lo];
            }
            out[(horizontal ? line * outLen + o : o * inW + line) * channels + c] = total ? sum / total : 0;
          }
        }
      }
      return out;
    };
    const rows = by1 - by0;
    const wide = pass(src, sw, bx0, bx1 - bx0, dw, rows, by0, true);     // dw x rows
    return pass(wide, dw, 0, rows, dh, dw, 0, false);                    // dw x dh
  }

  // One head portrait at `side` px: colour (not premultiplied) and alpha, resized premultiplied as Pillow resizes RGBA.
  function sizedHead(pack, index, side, cache) {
    const key = `${index}:${side}`;
    if (cache.has(key)) return cache.get(key);
    const size = pack.size;
    const rgba = pack.tiles[index];
    const pre = new Float32Array(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      const a = rgba[i * 4 + 3];
      pre[i * 4] = rgba[i * 4] * a / 255;
      pre[i * 4 + 1] = rgba[i * 4 + 1] * a / 255;
      pre[i * 4 + 2] = rgba[i * 4 + 2] * a / 255;
      pre[i * 4 + 3] = a;
    }
    const out = resample(pre, size, 4, [0, 0, size, size], side, side);
    for (let i = 0; i < side * side; i += 1) {
      const a = out[i * 4 + 3];
      if (a > 0) {
        out[i * 4] = Math.min(255, out[i * 4] * 255 / a);
        out[i * 4 + 1] = Math.min(255, out[i * 4 + 1] * 255 / a);
        out[i * 4 + 2] = Math.min(255, out[i * 4 + 2] * 255 / a);
      }
    }
    cache.set(key, out);
    return out;
  }

  function sizedFade(pack, side, cache) {
    const key = `fade:${side}`;
    if (!cache.has(key)) cache.set(key, resample(pack.fade, pack.size, 1, [0, 0, pack.size, pack.size], side, side));
    return cache.get(key);
  }

  // The Aniimo whose portrait shows through `window` ([x0, y0, x1, y1], picture px), its whole square being `square`
  // ([x, y, side]). { name, score, margin } or null. A first pass with the square as placed keeps a dozen candidates,
  // a second fits each a few px and a few % around (aLogs: icons.py head, with the lead portrait's fade).
  function head(image, pack, window, square, cache = new Map()) {
    const [X0, Y0, X1, Y1] = window;
    const n = COMPARE_WIDTH;
    const h = Math.max(4, pyRound(n * (Y1 - Y0) / (X1 - X0)));
    const k = n / (X1 - X0);
    const box = [Math.trunc(X0), Math.trunc(Y0), Math.trunc(X1), Math.trunc(Y1)];
    if (box[0] < 0 || box[1] < 0 || box[2] > image.width || box[3] > image.height || box[2] <= box[0] || box[3] <= box[1]) return null;
    const crop = resample(image.data, image.width, 4, box, n, h);          // RGBA; alpha unused
    const card = [0, 0, 0];
    for (let i = 0; i < n * h; i += 1) for (let c = 0; c < 3; c += 1) card[c] += crop[i * 4 + c];
    for (let c = 0; c < 3; c += 1) card[c] = Math.trunc(card[c] / (n * h));
    const side0 = square[2] * k;
    const ox0 = (square[0] - X0) * k;
    const oy0 = (square[1] - Y0) * k;
    const score = (index, scale, dx, dy) => {
      const side = Math.trunc(side0 * scale);
      const ox = pyRound(ox0 + (side0 - side) / 2) + dx;
      const oy = pyRound(oy0 + (side0 - side) / 2) + dy;
      if (ox > 0 || oy > 0 || ox + side < n || oy + side < h) return -1;   // the portrait must cover the whole part
      const art = sizedHead(pack, index, side, cache);
      const fade = sizedFade(pack, side, cache);
      let count = 0;
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const at = (y - oy) * side + (x - ox);
          const shown = art[at * 4 + 3] * fade[at] / 255;
          if (shown <= 64) continue;                                       // compared where a quarter or more shows
          count += 1;
          const mix = shown / 255;
          for (let c = 0; c < 3; c += 1) {
            const a = crop[(y * n + x) * 4 + c];
            const b = art[at * 4 + c] * mix + card[c] * (1 - mix);
            sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
          }
        }
      }
      if (count < 0.15 * n * h) return -1;                                 // too little of it shows
      const total = count * 3;
      const ma = sa / total;
      const mb = sb / total;
      const cov = sab / total - ma * mb;
      const va = saa / total - ma * ma;
      const vb = sbb / total - mb * mb;
      return cov / (Math.sqrt(Math.max(0, va * vb)) + 1e-6);
    };
    const first = pack.names.map((_, index) => [score(index, 1, 0, 0), index]).sort((a, b) => b[0] - a[0]).slice(0, 12);
    const best = new Map();
    for (const [, index] of first) {
      let top = -2;
      for (const scale of [0.95, 1, 1.05]) {
        for (let dx = -2; dx <= 2; dx += 1) for (let dy = -2; dy <= 2; dy += 1) top = Math.max(top, score(index, scale, dx, dy));
      }
      const name = pack.names[index];
      if (top > (best.get(name) ?? -2)) best.set(name, top);
    }
    const ranked = [...best].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return null;
    return { name: ranked[0][0], score: ranked[0][1], margin: ranked[0][1] - (ranked.length > 1 ? ranked[1][1] : -1) };
  }

  // Whether a match counts: clearly ahead of the next Aniimo (aLogs: tile_sure; no wrong answer passed on 312 tiles).
  const sure = (r) => Boolean(r && ((r.score >= 0.55 && r.margin >= 0.15) || (r.score >= 0.68 && r.margin >= 0.10)));

  // A skill badge's look at radius r px: the dark ring between its glyph and its edge, and the light rim round it.
  const badges = new Map();
  function badgeLook(r) {
    const k = Math.round(r * 2) / 2;
    if (!badges.has(k)) {
      const n = Math.trunc(k * 1.2) * 2 + 1;
      const c = Math.trunc(n / 2);
      const rgb = new Uint8Array(n * n * 3).fill(128);
      const mask = new Uint8Array(n * n);
      for (let y = 0; y < n; y += 1) {
        for (let x = 0; x < n; x += 1) {
          const d = Math.hypot(x - c, y - c);
          if (d > k * 1.07 || d <= k * 0.7) continue;
          mask[y * n + x] = 1;
          const dark = d <= k * 0.97;
          rgb[(y * n + x) * 3] = dark ? 60 : 220;
          rgb[(y * n + x) * 3 + 1] = dark ? 60 : 220;
          rgb[(y * n + x) * 3 + 2] = dark ? 75 : 220;
        }
      }
      badges.set(k, { n, c, rgb, mask });
    }
    return badges.get(k);
  }

  // The centre of the skill badge nearest (x, y): { score, x, y }, looked for `reach` px left and right and `reachY`
  // up and down, every `step` px, then to 1 px (aLogs: icons.py badge).
  function badge(image, x, y, r, reach, reachY, step) {
    const look = badgeLook(r);
    const { n, c, rgb, mask } = look;
    const at = (px, py) => {
      const x0 = pyRound(px) - c;
      const y0 = pyRound(py) - c;
      if (x0 < 0 || y0 < 0 || x0 + n > image.width || y0 + n > image.height) return -1;
      let out = 0;
      for (let ch = 0; ch < 3; ch += 1) {
        let count = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let j = 0; j < n; j += 1) {
          for (let i = 0; i < n; i += 1) {
            if (!mask[j * n + i]) continue;
            const a = image.data[((y0 + j) * image.width + x0 + i) * 4 + ch];
            const b = rgb[(j * n + i) * 3 + ch];
            count += 1; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
          }
        }
        if (!count) return -1;
        const ma = sa / count, mb = sb / count;
        out += (sab / count - ma * mb) / (Math.sqrt(Math.max(0, (saa / count - ma * ma) * (sbb / count - mb * mb))) + 1e-6);
      }
      return out / 3;
    };
    let best = { score: -2, x, y };
    const take = (px, py) => {
      const score = at(px, py);
      if (score > best.score) best = { score, x: px, y: py };
    };
    for (let dx = -reach; dx <= reach; dx += step) for (let dy = -reachY; dy <= reachY; dy += step) take(x + dx, y + dy);
    for (let round = 0; round < (step > 2 ? 2 : 1); round += 1) {
      const from = best;
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) take(from.x + dx, from.y + dy);
    }
    return best;
  }

  // One card's lead: { card, name, score, margin, sure } (name null where nothing could be compared).
  // image: { width, height, data: RGBA bytes }; pack: { size, names, tiles: [RGBA bytes], fade: bytes };
  // mode: "interlink" (four cards) or "eggheist" (three); cache: a Map kept across one picture's cards.
  function lead(image, pack, mode, card, cache = new Map()) {
    const [a, b] = (LAYOUTS[mode] || LAYOUTS.interlink)[card];
    const W = image.width;
    const H = image.height;
    const u = Math.min(W, H * 16 / 9);
    const ux = (W - u) / 2;
    const unit = TEAM_PITCH * u / 240;
    const centre = (t) => [ux + u * (t + TEAM_SQUARE[0] + TEAM_SQUARE[2] / 2), H * (b + TEAM_SQUARE[1]) + u * TEAM_SQUARE[2] / 2];
    // how far this card's team row sits from where it's measured, by its clearest skill badge (the game sometimes
    // draws a card higher or lower)
    let shift = { score: 0, x: 0, y: 0 };
    for (const i of [1, 0, 2]) {
      const [px, py] = centre(a + TEAM_PITCH * i);
      const found = badge(image, px + TEAM_BADGE[0] * unit, py, TEAM_BADGE[1] * unit, pyRound(30 * unit), pyRound(90 * unit),
        Math.max(2, pyRound(5 * unit)));
      if (found.score > shift.score) shift = { score: found.score, x: found.x - px - TEAM_BADGE[0] * unit, y: found.y - py };
      if (shift.score >= 0.6) break;
    }
    if (shift.score < 0.4) shift = { score: shift.score, x: 0, y: 0 };
    let [px, py] = centre(a);
    px += shift.x + LEAD_OFFSET[0] * unit;
    py += shift.y + LEAD_OFFSET[1] * unit;
    const half = LEAD_PORTRAIT * unit / 2;
    const [x0, y0, x1, y1] = LEAD_COMPARE;
    const r = head(image, pack, [px + x0 * unit, py + y0 * unit, px + x1 * unit, py + y1 * unit], [px - half, py - half, 2 * half], cache);
    return { card, name: r?.name ?? null, score: r?.score ?? 0, margin: r?.margin ?? 0, sure: sure(r) };
  }

  // Every card's lead, in the order the cards stand (the player in slot N has card N).
  function leads(image, pack, mode = "interlink") {
    const cache = new Map();
    return (LAYOUTS[mode] || LAYOUTS.interlink).map((_, card) => lead(image, pack, mode, card, cache));
  }

  // The run's lineup (the API's: [{ slot, name, aniimo, aniimoLevel, cp, team }]) with each lead as its picture shows
  // it. The picture decides; the name the app sent only confirms it:
  // - the same Aniimo: nothing changes;
  // - a name that is no Aniimo: it is the player's nickname for it (kept as `nickname`), the picture gives the species;
  // - another Aniimo: the picture's. When that card's level, CP and team are also another player's word for word (a
  //   card read twice), they were never this player's and are left out.
  // A lead the picture doesn't show clearly is left exactly as it was. Slots count from 0; the API leaves 0 out.
  function applyLeads(lineup, found, speciesNames) {
    if (!Array.isArray(lineup) || !Array.isArray(found)) return lineup;
    const species = new Set([...speciesNames].map((name) => String(name).toLowerCase()));
    const fold = (value) => String(value ?? "").trim().toLowerCase();
    const facts = (p) => JSON.stringify([fold(p.aniimo), p.aniimoLevel ?? null, p.cp ?? null, (p.team || []).map((m) => fold(m.aniimo))]);
    return lineup.map((player) => {
      const card = Number.isInteger(player.slot) ? player.slot : 0;
      const read = found.find((item) => item.card === card);
      if (!read?.sure || !read.name || player.ai) return player;
      const sent = player.aniimo;
      if (fold(sent) === fold(read.name)) return player;
      const renamed = Boolean(sent) && !species.has(fold(sent));
      const copied = !renamed && Boolean(sent) && lineup.some((other) => other !== player && facts(other) === facts(player));
      const team = copied ? undefined : (player.team || []).map((member) => (fold(member.aniimo) === fold(sent) && sent
        ? { ...member, aniimo: read.name, ...(renamed ? { nickname: sent } : {}) } : member));
      const out = { ...player, aniimo: read.name, ...(renamed ? { nickname: sent } : {}), team };
      if (copied) { delete out.aniimoLevel; delete out.cp; }
      if (!out.team) delete out.team;
      return out;
    });
  }

  const core = Object.freeze({ leads, lead, applyLeads, head, badge, sure, resample, LAYOUTS });
  const root = typeof window !== "undefined" ? window : globalThis;

  // -- in a browser -------------------------------------------------------------------------------------------------
  // The pack: the game's head portraits in one sheet (assets/party-heads/heads.webp) and what each tile is
  // (data/party_heads.json: { size, cols, names, fade }), from the site's content release. Loaded once, on the first
  // run opened that has a Party picture; null when it isn't there (then nothing changes on the page).
  let packLoading = null;
  function pixels(source, width, height) {
    const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement("canvas"), { width, height });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(source, 0, 0);
    return { width, height, data: context.getImageData(0, 0, width, height).data };
  }
  function loadPack() {
    if (!packLoading) {
      packLoading = (async () => {
        const base = String(root.ANIILOGS_CONFIG?.contentBaseUrl || "").replace(/\/+$/u, "");
        if (!base || typeof createImageBitmap !== "function") return null;
        const [metaResponse, sheetResponse] = await Promise.all([fetch(`${base}/data/party_heads.json`), fetch(`${base}/assets/party-heads/heads.webp`)]);
        if (!metaResponse.ok || !sheetResponse.ok) return null;
        const meta = await metaResponse.json();
        const bitmap = await createImageBitmap(await sheetResponse.blob());
        const sheet = pixels(bitmap, bitmap.width, bitmap.height);
        const size = meta.size;
        const tile = (index) => {
          const out = new Uint8Array(size * size * 4);
          const tx = (index % meta.cols) * size;
          const ty = Math.floor(index / meta.cols) * size;
          for (let y = 0; y < size; y += 1) out.set(sheet.data.subarray(((ty + y) * sheet.width + tx) * 4, ((ty + y) * sheet.width + tx + size) * 4), y * size * 4);
          return out;
        };
        const fadeTile = tile(meta.fade);
        const fade = new Uint8Array(size * size);
        for (let i = 0; i < size * size; i += 1) fade[i] = fadeTile[i * 4];
        return { size, names: meta.names, tiles: meta.names.map((_, index) => tile(index)), fade };
      })().catch(() => null);
    }
    return packLoading;
  }

  // A run's leads from its Party picture (a Blob): the lineup with each lead as the picture shows it, or the lineup
  // as it was when the pack or the picture can't be read. One card at a time, giving the page a moment between them.
  const done = new Map();                                  // run id -> the corrected lineup's promise
  function lineupFromPicture(runId, lineup, loadPicture, mode = "interlink") {
    if (!Array.isArray(lineup) || !lineup.length) return Promise.resolve(lineup);
    if (!done.has(runId)) {
      done.set(runId, (async () => {
        const pack = await loadPack();
        if (!pack) return lineup;
        const bitmap = await createImageBitmap(await loadPicture());
        const image = pixels(bitmap, bitmap.width, bitmap.height);
        const cache = new Map();
        const found = [];
        for (let card = 0; card < (LAYOUTS[mode] || LAYOUTS.interlink).length; card += 1) {
          found.push(lead(image, pack, mode, card, cache));
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return applyLeads(lineup, found, pack.names);
      })().catch(() => lineup));
    }
    return done.get(runId);
  }

  root.AniilogsPartyPortraits = { core, lineupFromPicture };
})();
