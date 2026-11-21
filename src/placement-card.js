// game-audit: n/a draws a placement's share card from board figures; no game data
// A placement's share card: a 1200x630 PNG drawn without a canvas library, so it fits the API's small CPU budget.
// Flat rectangles and pre-rasterised letters (src/card-glyphs.js) on an indexed-colour image (one byte a pixel, at
// most 256 colours), deflated by the runtime's own CompressionStream.
// The letters (src/card-glyphs.js) come in with each call, from src/index.js: the API build inlines modules that import
// nothing themselves.
let CARD_FONTS = null;

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

// the site's Night theme (public/styles.css)
const COLORS = Object.freeze({
  paper: [11, 18, 21], panel: [18, 29, 33], ink: [244, 244, 233], soft: [155, 181, 178], mint: [98, 217, 179],
  teal: [121, 229, 194], gold: [244, 189, 79], coral: [244, 137, 114], line: [40, 62, 64], silver: [201, 214, 212], bronze: [224, 160, 116],
});

let atlasPromise = null;
async function atlas({ atlas: CARD_ATLAS, atlasBytes: CARD_ATLAS_BYTES, fonts }) {
  CARD_FONTS = fonts;
  if (!atlasPromise) {
    atlasPromise = (async () => {
      const text = atob(CARD_ATLAS);
      const packed = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i += 1) packed[i] = text.charCodeAt(i);
      const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      if (bytes.length !== CARD_ATLAS_BYTES) throw new Error("Card letters are damaged.");
      return bytes;
    })().catch((error) => { atlasPromise = null; throw error; });
  }
  return atlasPromise;
}

// A flat colour gets its own palette entry; the in-between colours of a letter's edge share one when they are within 8
// levels a channel (the eye can't tell them apart at a letter's edge), so the 256 entries last.
const rgbKey = ([r, g, b]) => 0x1000000 | (r << 16) | (g << 8) | b;
const edgeKey = ([r, g, b]) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

// An indexed image: pixels are palette indices, stored as PNG's raw scanlines (a filter byte, then the row) so the
// encoder needs no copy.
class Picture {
  constructor(width, height, letters) {
    this.width = width; this.height = height; this.stride = width + 1; this.letters = letters;
    this.raw = new Uint8Array(this.stride * height);
    this.palette = []; this.index = new Map(); this.blends = new Map();
  }
  color(rgb, edge = false) {
    const key = edge ? edgeKey(rgb) : rgbKey(rgb);
    let at = this.index.get(key);
    if (at !== undefined) return at;
    if (this.palette.length < 256) {
      at = this.palette.length; this.palette.push(rgb);
    } else {                                   // full: the nearest colour already in the image
      let best = Infinity;
      this.palette.forEach(([r, g, b], i) => {
        const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
        if (d < best) { best = d; at = i; }
      });
    }
    this.index.set(key, at);
    return at;
  }
  // colour `fg` at coverage level/15 over whatever the pixel shows
  blend(fg, bgIndex, level) {
    const step = (level + 1) >> 1;                       // 8 steps of coverage are enough at a letter's edge
    const key = fg * 4096 + bgIndex * 16 + step;
    let at = this.blends.get(key);
    if (at === undefined) {
      const a = step / 8; const f = this.palette[fg]; const b = this.palette[bgIndex];
      at = this.color([0, 1, 2].map((i) => Math.round(f[i] * a + b[i] * (1 - a))), true);
      this.blends.set(key, at);
    }
    return at;
  }
  fill(x, y, w, h, rgb) {                              // rgb: [r, g, b], or a palette index
    const c = typeof rgb === "number" ? rgb : this.color(rgb);
    const x0 = Math.max(0, Math.round(x)); const x1 = Math.min(this.width, Math.round(x + w));
    const y0 = Math.max(0, Math.round(y)); const y1 = Math.min(this.height, Math.round(y + h));
    if (x1 <= x0) return;
    for (let row = y0; row < y1; row += 1) this.raw.fill(c, row * this.stride + 1 + x0, row * this.stride + 1 + x1);
  }
  // a rectangle with round corners; a corner pixel is blended by how far its centre is from the curve
  round(x, y, w, h, r, rgb) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    const c = this.color(rgb);
    this.fill(x + r, y, w - 2 * r, h, rgb);
    this.fill(x, y + r, r, h - 2 * r, rgb);
    this.fill(x + w - r, y + r, r, h - 2 * r, rgb);
    const corner = (cx, cy, px0, py0) => {
      for (let py = py0; py < py0 + r; py += 1) {
        const dy = py + 0.5 - cy;
        for (let px = px0; px < px0 + r; px += 1) {
          const dx = px + 0.5 - cx;
          const level = Math.round(Math.max(0, Math.min(1, r + 0.5 - Math.sqrt(dx * dx + dy * dy))) * 15);
          if (level) this.put(px, py, c, level);
        }
      }
    };
    corner(x + r, y + r, x, y); corner(x + w - r, y + r, x + w - r, y);
    corner(x + r, y + h - r, x, y + h - r); corner(x + w - r, y + h - r, x + w - r, y + h - r);
  }
  // an outlined pill: the outline colour, then the inside
  pill(x, y, w, h, line, inside, thickness = 2) {
    this.round(x, y, w, h, Math.floor(h / 2), line);
    this.round(x + thickness, y + thickness, w - 2 * thickness, h - 2 * thickness, Math.floor(h / 2) - thickness, inside);
  }
  put(x, y, c, level) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || level <= 0) return;
    const at = y * this.stride + 1 + x;
    this.raw[at] = level >= 15 ? c : this.blend(c, this.raw[at], level);
  }
  // letters: the glyph's own key, or a letter with an accent split off (NFD)
  glyphs(text, fontName) {
    const font = CARD_FONTS[fontName];
    const marks = { "́": "acute", "̀": "grave", "̂": "circumflex", "̈": "diaeresis", "̃": "tilde", "̊": "ring" };
    const out = [];
    for (const char of String(text).normalize("NFD")) {
      const mark = marks[char];
      if (mark) {
        const base = out[out.length - 1];
        const key = `${mark}.${base && /[A-Z]/u.test(base.char) ? "u" : "l"}`;
        if (base && font.glyphs[key]) out.push({ char, glyph: font.glyphs[key], over: base });
        continue;
      }
      if (/\p{M}/u.test(char)) continue;                 // another accent: the letter without it
      const glyph = font.glyphs[char] || (font.glyphs[char.toUpperCase()] && !font.glyphs[char.toLowerCase()] ? font.glyphs[char.toUpperCase()] : null);
      out.push({ char, glyph, missing: !glyph });
    }
    return out;
  }
  measure(text, fontName, spacing = 0) {
    const font = CARD_FONTS[fontName];
    let width = 0;
    for (const item of this.glyphs(text, fontName)) {
      if (item.over) continue;
      width += (item.glyph ? item.glyph[0] / 16 : font.size * 0.62) + spacing;
    }
    return Math.max(0, width - spacing);
  }
  // text with its baseline at y; align left (x is where it starts), right or center
  text(text, x, y, fontName, rgb, { align = "left", spacing = 0, max = Infinity } = {}) {
    const font = CARD_FONTS[fontName];
    let shown = String(text);
    if (this.measure(shown, fontName, spacing) > max) {   // too long: cut with an ellipsis-like "..."
      while (shown.length > 1 && this.measure(`${shown}...`, fontName, spacing) > max) shown = [...shown].slice(0, -1).join("");
      shown = `${shown.trimEnd()}...`;
    }
    const width = this.measure(shown, fontName, spacing);
    let pen = align === "right" ? x - width : align === "center" ? x - width / 2 : x;
    const c = this.color(rgb);
    const letters = this.letters;
    for (const item of this.glyphs(shown, fontName)) {
      if (item.missing) {                              // a letter the card has no drawing of: an empty box
        const w = font.size * 0.5; const h = font.capHeight; const t = Math.max(1, Math.round(font.size / 18));
        const bx = Math.round(pen + font.size * 0.06); const by = Math.round(y - h);
        this.fill(bx, by, w, t, rgb); this.fill(bx, by + h - t, w, t, rgb);
        this.fill(bx, by, t, h, rgb); this.fill(bx + w - t, by, t, h, rgb);
        pen += font.size * 0.62 + spacing;
        continue;
      }
      const [advance, left, top, , height, offset] = item.glyph;
      // an accent sits over the middle of the letter before it
      const ox = item.over ? Math.round(item.over.x + item.over.advance / 2) : Math.round(pen);
      // each row's spans: a solid one is one fill, an edge's pixels are blended one by one
      let at = offset;
      for (let row = 0; row < height; row += 1) {
        const py = y + top + row;
        const spans = letters[at++];
        for (let s = 0; s < spans; s += 1) {
          const sx = ox + left + letters[at]; const len = letters[at + 1]; const level = letters[at + 2];
          at += 3;
          if (py < 0 || py >= this.height) continue;
          if (level === 15) {
            const x0 = Math.max(0, sx); const x1 = Math.min(this.width, sx + len);
            if (x1 > x0) this.raw.fill(c, py * this.stride + 1 + x0, py * this.stride + 1 + x1);
          } else {
            for (let k = 0; k < len; k += 1) this.put(sx + k, py, c, level);
          }
        }
      }
      if (!item.over) {
        item.x = Math.round(pen); item.advance = advance / 16;
        pen += advance / 16 + spacing;
      }
    }
    return width;
  }
  async png() {
    const crcTable = Picture.crcTable || (Picture.crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    }));
    const chunk = (type, data) => {
      const out = new Uint8Array(12 + data.length);
      const view = new DataView(out.buffer);
      view.setUint32(0, data.length);
      for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
      out.set(data, 8);
      let crc = 0xffffffff;
      for (let i = 4; i < 8 + data.length; i += 1) crc = crcTable[(crc ^ out[i]) & 0xff] ^ (crc >>> 8);
      view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
      return out;
    };
    const header = new Uint8Array(13);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, this.width); hv.setUint32(4, this.height);
    header.set([8, 3, 0, 0, 0], 8);                    // 8-bit, indexed colour
    const plte = new Uint8Array(this.palette.length * 3);
    this.palette.forEach((rgb, i) => plte.set(rgb, i * 3));
    const idat = zlibRuns(this.raw, this.stride);
    const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("PLTE", plte), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
    const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { png.set(part, at); at += part.length; }
    return png;
  }
}

// A zlib stream (what PNG's IDAT holds) of the picture's scanlines, made for flat pictures: one fixed-Huffman deflate
// block whose only matches repeat the pixel to the left (distance 1) or the one above (distance = a row). The runtime's
// own deflate (CompressionStream, level 6) searches far more and took about 8 ms of CPU for one card; this about 2.
const FIXED = (() => {
  const reverse = (code, bits) => { let out = 0; for (let i = 0; i < bits; i += 1) { out = (out << 1) | (code & 1); code >>= 1; } return out; };
  // literal/length symbol -> [bits reversed for LSB-first writing, bit count]
  const lit = new Uint32Array(288); const litBits = new Uint8Array(288);
  for (let s = 0; s < 288; s += 1) {
    const [base, bits, first] = s < 144 ? [0x30, 8, 0] : s < 256 ? [0x190, 9, 144] : s < 280 ? [0, 7, 256] : [0xc0, 8, 280];
    lit[s] = reverse(base + s - first, bits); litBits[s] = bits;
  }
  // match length 3..258 -> symbol, extra bits, extra value
  const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const lenSym = new Uint16Array(259); const lenExtraBits = new Uint8Array(259); const lenExtraVal = new Uint16Array(259);
  for (let len = 3; len <= 258; len += 1) {
    let k = lengthBase.length - 1;
    while (lengthBase[k] > len) k -= 1;
    lenSym[len] = 257 + k; lenExtraBits[len] = lengthExtra[k]; lenExtraVal[len] = len - lengthBase[k];
  }
  const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const distance = (d) => {
    let k = distBase.length - 1;
    while (distBase[k] > d) k -= 1;
    return [reverse(k, 5), distExtra[k], d - distBase[k]];
  };
  return { lit, litBits, lenSym, lenExtraBits, lenExtraVal, distance };
})();
export function zlibRuns(data, stride) {
  const { lit, litBits, lenSym, lenExtraBits, lenExtraVal, distance } = FIXED;
  const out = new Uint8Array(data.length + (data.length >> 3) + 64);
  let at = 2;
  out[0] = 0x78; out[1] = 0x01;                          // zlib header: deflate, 32K window, no dictionary
  let bitbuf = 3; let bitcnt = 3;                        // the last block, fixed Huffman codes
  const [rowCode, rowExtraBits, rowExtra] = distance(stride);
  // each step writes one code: a literal, or a length and its distance (the buffer is emptied to under 8 bits between)
  const n = data.length;
  let i = 0;
  while (i < n) {
    const max = n - i < 258 ? n - i : 258;
    let left = 0; let up = 0;
    if (i > 0) { const c = data[i - 1]; while (left < max && data[i + left] === c) left += 1; }
    // a long run to the left is good enough: the row above isn't compared then
    if (left < 32 && left < max && i >= stride) { const from = i - stride; while (up < max && data[i + up] === data[from + up]) up += 1; }
    let len = 0;
    if (left >= 3 && left >= up) len = left;
    else if (up >= 3) len = up;
    if (len) {
      const sym = lenSym[len];
      bitbuf |= lit[sym] << bitcnt; bitcnt += litBits[sym];
      if (lenExtraBits[len]) { bitbuf |= lenExtraVal[len] << bitcnt; bitcnt += lenExtraBits[len]; }
      while (bitcnt >= 8) { out[at++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
      if (len === left) { bitcnt += 5; }                 // distance 1: code 0, no extra bits
      else {
        bitbuf |= rowCode << bitcnt; bitcnt += 5;
        if (rowExtraBits) { bitbuf |= rowExtra << bitcnt; bitcnt += rowExtraBits; }
      }
      i += len;
    } else {
      const v = data[i];
      bitbuf |= lit[v] << bitcnt; bitcnt += litBits[v];
      i += 1;
    }
    while (bitcnt >= 8) { out[at++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
  }
  bitbuf |= lit[256] << bitcnt; bitcnt += litBits[256];  // end of block
  while (bitcnt > 0) { out[at++] = bitbuf & 255; bitbuf >>>= 8; bitcnt -= 8; }
  let a = 1; let b = 0;                                  // Adler-32 of the data
  for (let start = 0; start < n; start += 5552) {
    const end = Math.min(n, start + 5552);
    for (let k = start; k < end; k += 1) { a += data[k]; b += a; }
    a %= 65521; b %= 65521;
  }
  out[at++] = (b >>> 8) & 255; out[at++] = b & 255; out[at++] = (a >>> 8) & 255; out[at++] = a & 255;
  return out.subarray(0, at);
}
// The card, as mockup 5: the brand and mode over the place, the boss and week; the players with their Avg DPS on the
// left, the ladder's figure, stars and how the run ended on the right. model: {
//   place, ladder ("Score"), figure ("96,200"), boss, slot ("Center"), week ("Week of Nov 18 – Nov 25"), stars,
//   result ("Boss Killed: 1:58"), extra ("Team DPS 140,578"), tag ("Duo" | null), players: [{ name, dps, mark }] }
let backdrop = null;                                     // the background, drawn once per isolate and copied
function background(letters) {
  if (backdrop) {
    const p = new Picture(CARD_WIDTH, CARD_HEIGHT, letters);
    p.raw.set(backdrop.raw); p.palette = backdrop.palette.slice(); p.index = new Map(backdrop.index);
    return p;
  }
  const p = new Picture(CARD_WIDTH, CARD_HEIGHT, letters);
  const W = CARD_WIDTH; const H = CARD_HEIGHT;
  p.fill(0, 0, W, H, COLORS.paper);
  // a soft teal light from the top left and a warm one from the bottom right, in a few flat steps
  const glow = (cx, cy, rgb, outer, inner, steps) => {
    for (let s = 0; s < steps; s += 1) {
      const r = Math.round(outer - ((outer - inner) * s) / (steps - 1));
      const mix = (s + 1) / steps;
      const c = p.color(COLORS.paper.map((v, i) => Math.round(v + (rgb[i] - v) * mix)));
      for (let y = Math.max(0, cy - r); y < Math.min(H, cy + r); y += 2) {
        const dy = Math.min(Math.abs(y - cy), Math.abs(y + 2 - cy));
        const half = Math.sqrt(Math.max(0, r * r - dy * dy));
        p.fill(cx - half, y, half * 2, 2, c);
      }
    }
  };
  glow(0, 0, [22, 62, 54], 760, 220, 12);
  glow(W, H, [48, 41, 23], 560, 200, 9);
  backdrop = { raw: p.raw.slice(), palette: p.palette.slice(), index: new Map(p.index) };
  return p;
}

export async function drawPlacementCard(model, letters) {
  const p = background(await atlas(letters));
  const W = CARD_WIDTH;
  const PAD = 64;
  // top: brand and mode
  const brandWidth = p.text("Anii", PAD, 104, "title", COLORS.ink);
  p.text("Logs", PAD + brandWidth + 2, 104, "title", COLORS.mint);
  const badges = [["HOLO-BATTLE INTERLINK", COLORS.soft]];
  if (model.tag) badges.unshift([String(model.tag).toUpperCase(), COLORS.gold]);
  let right = W - PAD;
  for (const [label, rgb] of badges) {
    const w = p.measure(label, "label", 2) + 44;
    p.pill(right - w, 62, w, 50, rgb, COLORS.paper, 3);
    p.text(label, right - w / 2, 95, "label", rgb === COLORS.soft ? COLORS.ink : rgb, { align: "center", spacing: 2 });
    right -= w + 14;
  }
  // the place, the boss, and which board
  const placeColor = model.place === 1 ? COLORS.gold : model.place === 2 ? COLORS.silver : model.place === 3 ? COLORS.bronze : COLORS.soft;
  const placeWidth = p.text(`#${model.place}`, PAD - 6, 278, "place", placeColor);
  const textLeft = PAD + placeWidth + 34;
  p.text(model.boss || "Interlink boss", textLeft, 214, "title", COLORS.ink, { max: W - PAD - textLeft });
  p.text([model.slot, model.week].filter(Boolean).join(" · "), textLeft, 260, "small", COLORS.soft, { max: W - PAD - textLeft });
  p.text(`ranked by ${model.ladder}`, textLeft, 296, "small", COLORS.soft, { max: W - PAD - textLeft });
  // the players and their Avg DPS
  const players = (model.players || []).slice(0, 4);
  const listTop = 372;
  p.fill(PAD, listTop - 22, 520, 2, COLORS.line);
  p.text("AVG DPS", PAD, listTop + 12, "label", COLORS.soft, { spacing: 2 });
  players.forEach((player, i) => {
    const y = listTop + 64 + i * 50;
    const top = i === 0 && player.dps;
    if (player.mark) p.round(PAD - 18, y - 30, 6, 34, 3, COLORS.mint);
    // a bot: a small "AI" pill after its name (the name gives way to it when long)
    const pill = player.ai ? p.measure("AI", "label", 2) + 22 : 0;
    const nameWidth = p.text(player.name, PAD, y, "body", player.ai ? COLORS.soft : COLORS.ink, { max: 360 - (pill ? pill + 12 : 0) });
    if (pill) {
      const x = PAD + Math.min(nameWidth, 360 - pill - 12) + 12;
      p.pill(x, y - 29, pill, 32, COLORS.soft, COLORS.paper, 2);
      p.text("AI", x + pill / 2, y - 6, "label", COLORS.soft, { align: "center", spacing: 2 });
    }
    p.text(player.dps || "–", PAD + 520, y, "body", top ? COLORS.gold : player.dps ? COLORS.ink : COLORS.soft, { align: "right" });
  });
  // the ladder's figure, the stars and how it ended
  p.text(model.figure, W - PAD, 468, "figure", COLORS.mint, { align: "right" });
  // "★ 40 · Boss Killed: 1:58", the star in gold
  const starLine = [model.stars != null ? String(model.stars) : null, model.result].filter(Boolean).join(" · ");
  if (starLine) {
    const lineWidth = p.text(starLine, W - PAD, 524, "body", COLORS.ink, { align: "right", max: 520 });
    if (model.stars != null) p.text("★", W - PAD - Math.min(lineWidth, 520) - 10, 524, "body", COLORS.gold, { align: "right" });
  }
  if (model.extra) p.text(model.extra, W - PAD, 566, "small", COLORS.soft, { align: "right", max: 560 });
  return p.png();
}
