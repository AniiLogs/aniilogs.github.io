// game-audit: n/a draws a placement's share card from board figures; no game data
// A placement's share card: a 1200x630 PNG drawn without a canvas library, so it fits the API's small CPU budget.
// Flat rectangles and pre-rasterised letters (src/card-glyphs.js) on an indexed-colour image (one byte a pixel, at
// most 256 colours), deflated by its own small encoder (zlibRuns). Names in other scripts take their letters from packs
// kept in R2 (src/placement-links.js).
// The letters (src/card-glyphs.js) come in with each call, from src/index.js: the API build inlines modules that import
// nothing themselves.
let CARD_FONTS = null;

// the accents the card draws over its own letters
const MARKS = Object.freeze({ "́": "acute", "̀": "grave", "̂": "circumflex", "̈": "diaeresis", "̃": "tilde", "̊": "ring" });
function ownGlyph(font, char) {
  return font.glyphs[char] || (font.glyphs[char.toUpperCase()] && !font.glyphs[char.toLowerCase()] ? font.glyphs[char.toUpperCase()] : null);
}
// The script packs a text needs on the names' size (fonts: the card's letter sets): the block (first code point, 4 hex
// digits) of each letter the card can't draw itself, letter or letter-and-accents
export function packBlocksFor(texts, fonts) {
  const font = fonts.body;
  const blocks = new Set();
  for (const text of texts) {
    for (const whole of String(text ?? "").normalize("NFC")) {
      if (ownGlyph(font, whole)) continue;
      const [base, ...marks] = [...whole.normalize("NFD")];
      if (marks.length && ownGlyph(font, base) && marks.every((mark) => MARKS[mark])) continue;
      const cp = whole.codePointAt(0);
      if (cp > 0x7e && cp <= 0xffff) blocks.add((cp & 0xff00).toString(16).padStart(4, "0"));
    }
  }
  return [...blocks].sort();
}
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
      for (let i = 0; i < this.palette.length; i += 1) {
        const c = this.palette[i];
        const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
        if (d < best) { best = d; at = i; }
      }
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
  // letters: the card's own drawing of a letter; else that letter with its accents drawn over it (NFD); else, on the
  // names' size, a letter from the script packs (this.extra, src/placement-links.js); else the letter without accents
  // it has no drawing of; else an empty box
  glyphs(text, fontName) {
    const font = CARD_FONTS[fontName];
    const extra = fontName === "body" ? this.extra : null;
    const out = [];
    for (const whole of String(text).normalize("NFC")) {
      const own = ownGlyph(font, whole);
      if (own) { out.push({ char: whole, glyph: own }); continue; }
      const [base, ...marks] = [...whole.normalize("NFD")];
      const accents = (all) => {
        const item = { char: base, glyph: ownGlyph(font, base) };
        out.push(item);
        for (const mark of marks) {
          const key = `${MARKS[mark]}.${/[A-Z]/u.test(base) ? "u" : "l"}`;
          if (MARKS[mark] && font.glyphs[key]) out.push({ char: mark, glyph: font.glyphs[key], over: item });
          else if (all) return;
        }
      };
      if (marks.length && ownGlyph(font, base) && marks.every((mark) => MARKS[mark])) { accents(true); continue; }
      const packed = extra?.get(whole.codePointAt(0));
      if (packed) { out.push({ char: whole, glyph: packed, packed: true }); continue; }
      if (marks.length && ownGlyph(font, base)) { accents(false); continue; }   // the accents it has, the letter
      if (/^\p{M}+$/u.test(whole)) continue;             // a lone accent: left out
      out.push({ char: whole, glyph: null, missing: true });
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
      const [advance, left, top, width, height, offset, bits] = item.glyph;
      if (item.packed) {                                 // a script pack's letter: 4-bit coverage, two pixels a byte
        const ox = Math.round(pen);
        for (let row = 0; row < height; row += 1) {
          for (let col = 0; col < width; col += 1) {
            const i = row * width + col; const byte = bits[offset + (i >> 1)];
            const level = i & 1 ? byte & 15 : byte >> 4;
            if (level) this.put(ox + left + col, y + top + row, c, level);
          }
        }
        pen += advance / 16 + spacing;
        continue;
      }
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

// The boss's name in full: the title's size (54) when it fits its room, else the next smaller (48, 42, 36) that does; a
// name too long even at 36 is cut there. A two-boss fight ("Alpha Glameep + Alpha Jabster") needs the smaller sizes.
export const CARD_TITLE_FONTS = Object.freeze(["title", "title48", "title42", "title36"]);
// measure(fontName): the name's width in that size (Picture.measure)
export function cardTitleFont(measure, room) {
  return CARD_TITLE_FONTS.find((name) => measure(name) <= room) || CARD_TITLE_FONTS.at(-1);
}

export async function drawPlacementCard(model, letters) {
  const p = background(await atlas(letters));
  p.extra = letters.extra || null;                       // letters from the script packs: code point -> glyph
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
  const title = model.boss || "Interlink boss";
  const titleFont = cardTitleFont((name) => p.measure(title, name), W - PAD - textLeft);
  p.text(title, textLeft, 214, titleFont, COLORS.ink, { max: W - PAD - textLeft });
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

// ---------------------------------------------------------------- pictures on the cards (Aniimo art, map art)
// A PNG read back into pixels: 8-bit greyscale, RGB, palette, grey+alpha or RGBA, not interlaced (what the content
// release's icons are). Returns { width, height, rgba }; a
// palette picture gives { width, height, palette: [[r, g, b]...], indices } instead (one byte a pixel), so a picture
// already cut to a few colours keeps them (and costs no more than its bytes). Throws on anything else. options: inflate (bytes -> bytes; default the runtime's
// DecompressionStream) and maxPixels (default 4096 x 4096).
const PNG_CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
export async function decodePng(bytes, { inflate = null, maxPixels = 4096 * 4096 } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (data.length < 33 || signature.some((byte, i) => data[i] !== byte)) throw new Error("Not a PNG picture.");
  let at = 8; let header = null; let palette = null; let alpha = null; const parts = [];
  while (at + 8 <= data.length) {
    const length = view.getUint32(at); const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    const body = data.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new Error("A PNG chunk is cut short.");
    if (type === "IHDR") header = { width: view.getUint32(at + 8), height: view.getUint32(at + 12), depth: body[8], type: body[9], interlace: body[12] };
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") parts.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  const channels = header ? PNG_CHANNELS[header.type] : undefined;
  if (!header || header.depth !== 8 || !channels || header.interlace) throw new Error("Only 8-bit, not interlaced PNG pictures are read.");
  const { width, height } = header;
  if (!width || !height || width * height > maxPixels) throw new Error("The PNG picture is too large.");
  const packed = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { packed.set(part, offset); offset += part.length; }
  const raw = inflate ? await inflate(packed)
    : new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("The PNG picture's data is cut short.");
  const pixels = new Uint8Array(stride * height);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {                 // undo each row's filter
    const filter = raw[y * (stride + 1)]; const from = y * (stride + 1) + 1; const to = y * stride;
    const line = raw.subarray(from, from + stride); const out = pixels.subarray(to, to + stride);
    const above = y ? pixels.subarray(to - stride, to) : zero;
    const c = channels;
    if (filter === 0) out.set(line);
    else if (filter === 1) {
      for (let x = 0; x < c; x += 1) out[x] = line[x];
      for (let x = c; x < stride; x += 1) out[x] = line[x] + out[x - c];
    } else if (filter === 2) {
      for (let x = 0; x < stride; x += 1) out[x] = line[x] + above[x];
    } else if (filter === 3) {
      for (let x = 0; x < c; x += 1) out[x] = line[x] + (above[x] >> 1);
      for (let x = c; x < stride; x += 1) out[x] = line[x] + ((out[x - c] + above[x]) >> 1);
    } else if (filter === 4) {
      for (let x = 0; x < c; x += 1) out[x] = line[x] + above[x];
      for (let x = c; x < stride; x += 1) {
        const left = out[x - c]; const up = above[x]; const corner = above[x - c];
        const pa = Math.abs(up - corner); const pb = Math.abs(left - corner); const pc = Math.abs(left + up - 2 * corner);
        out[x] = line[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner);
      }
    } else throw new Error("The PNG picture has an unknown row filter.");
  }
  if (header.type === 3 && palette) {                  // a palette picture: its colours and indices (no rgba)
    const colours = Array.from({ length: palette.length / 3 }, (_, i) => [palette[i * 3], palette[i * 3 + 1], palette[i * 3 + 2]]);
    return { width, height, palette: colours, indices: pixels, alpha };
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < pixels.length; i += channels, o += 4) {
    if (header.type === 3) {
      const c = pixels[i];
      rgba[o] = palette?.[c * 3] ?? 0; rgba[o + 1] = palette?.[c * 3 + 1] ?? 0; rgba[o + 2] = palette?.[c * 3 + 2] ?? 0;
      rgba[o + 3] = alpha && c < alpha.length ? alpha[c] : 255;
    } else if (channels <= 2) {
      rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[i]; rgba[o + 3] = channels === 2 ? pixels[i + 1] : 255;
    } else {
      rgba[o] = pixels[i]; rgba[o + 1] = pixels[i + 1]; rgba[o + 2] = pixels[i + 2]; rgba[o + 3] = channels === 4 ? pixels[i + 3] : 255;
    }
  }
  return { width, height, rgba };
}

// The colours a picture is drawn in (the card holds 256): median cut over 5-bit colour boxes, weighted by how many
// pixels have each. colours: a Uint32Array of 32768 counts, by (r >> 3) << 10 | (g >> 3) << 5 | b >> 3. Returns the
// boxes' mean colours, at most `count` of them.
export function medianCut(colours, count) {
  let boxes = [];
  const keys = [];
  for (let key = 0; key < 32768; key += 1) if (colours[key]) keys.push(key);
  if (!keys.length) return [];
  const channel = (key, c) => (c === 0 ? key >> 10 : c === 1 ? (key >> 5) & 31 : key & 31);
  const describe = (list) => {
    const lo = [31, 31, 31]; const hi = [0, 0, 0]; let weight = 0;
    for (const key of list) {
      weight += colours[key];
      for (let c = 0; c < 3; c += 1) { const v = channel(key, c); if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
    }
    const spans = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const widest = spans.indexOf(Math.max(...spans));
    return { list, weight, widest, span: spans[widest] };
  };
  boxes.push(describe(keys));
  while (boxes.length < count) {
    // split the box with the most weight that can still be split (by its widest channel, at its weighted median)
    let pick = -1; let best = -1;
    boxes.forEach((box, i) => { const score = box.span ? box.weight * box.span : -1; if (score > best) { best = score; pick = i; } });
    if (pick < 0) break;
    const box = boxes[pick];
    const sorted = box.list.slice().sort((a, b) => channel(a, box.widest) - channel(b, box.widest));
    let half = 0; let cut = 0;
    while (cut < sorted.length - 1 && half + colours[sorted[cut]] <= box.weight / 2) { half += colours[sorted[cut]]; cut += 1; }
    cut = Math.max(1, cut);
    boxes = [...boxes.slice(0, pick), describe(sorted.slice(0, cut)), describe(sorted.slice(cut)), ...boxes.slice(pick + 1)];
  }
  return boxes.map(({ list, weight }) => {
    const sum = [0, 0, 0];
    for (const key of list) for (let c = 0; c < 3; c += 1) sum[c] += ((channel(key, c) << 3) | 4) * colours[key];
    return sum.map((value) => Math.round(value / weight));
  });
}

// Puts a picture (rgba, width x height) into the card at x, y, scaled to w x h, over the flat colour `under` (what the
// card shows there), in at most `count` colours of its own. The colours are worked out at the picture's own size and
// the result is scaled by repeating pixels: a link preview shows the card at about a third of its size, where that
// can't be told from smooth scaling, at a quarter of the work (the API has about 10 ms a request).
function placeArt(p, art, x, y, w, h, under, count) {
  const { width: sw, height: sh, rgba } = art;
  const keys = new Int32Array(sw * sh).fill(-1);        // each source pixel's 5-bit colour box over `under`
  const colours = new Uint32Array(32768);
  const [ur, ug, ub] = under;
  for (let i = 0, o = 0; o < keys.length; i += 4, o += 1) {
    const alpha = rgba[i + 3];
    if (alpha < 6) continue;
    const a = alpha / 255; const rest = 1 - a;
    const key = (((rgba[i] * a + ur * rest) >> 3) << 10) | (((rgba[i + 1] * a + ug * rest) >> 3) << 5) | ((rgba[i + 2] * a + ub * rest) >> 3);
    keys[o] = key;
    colours[key] += 1;
  }
  const palette = medianCut(colours, count).map((rgb) => p.color(rgb));
  const nearest = new Int16Array(32768).fill(-1);
  for (let key = 0; key < 32768; key += 1) {            // each box used: its nearest colour of the picture's own
    if (!colours[key]) continue;
    const r = ((key >> 10) << 3) | 4; const g = (((key >> 5) & 31) << 3) | 4; const b = ((key & 31) << 3) | 4;
    let best = Infinity; let pick = 0;
    for (const index of palette) {
      const c = p.palette[index];
      const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
      if (d < best) { best = d; pick = index; }
    }
    nearest[key] = pick;
  }
  const cols = new Int32Array(w);
  for (let tx = 0; tx < w; tx += 1) cols[tx] = Math.min(sw - 1, Math.floor(((tx + 0.5) * sw) / w));
  for (let ty = 0; ty < h; ty += 1) {
    const py = y + ty;
    if (py < 0 || py >= p.height) continue;
    const row = Math.min(sh - 1, Math.floor(((ty + 0.5) * sh) / h)) * sw;
    for (let tx = 0; tx < w; tx += 1) {
      const key = keys[row + cols[tx]]; const px = x + tx;
      if (key >= 0 && px >= 0 && px < p.width) p.raw[py * p.stride + 1 + px] = nearest[key];
    }
  }
}

// The card's letters lack a few marks game text uses: long dashes, curly quotes and the ellipsis become their plain kin
export const cardText = (value) => String(value ?? "").replace(/[—―]/gu, "–").replace(/[‘’ʼ]/gu, "'").replace(/[“”]/gu, '"')
  .replace(/…/gu, "...").replace(/\s+/gu, " ").trim();
// words laid out in lines at most `width` wide; the last line ends "..." when there was more
function wrapLines(p, text, font, width, lines) {
  const words = cardText(text).split(" ").filter(Boolean);
  const out = [];
  let line = "";
  for (let i = 0; i < words.length; i += 1) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (p.measure(next, font) <= width || !line) { line = next; continue; }
    out.push(line); line = words[i];
    if (out.length === lines) { line = ""; out[lines - 1] = `${out[lines - 1]} ${words.slice(i).join(" ")}`; break; }
  }
  if (line) out.push(line);
  return out.slice(0, lines);
}
const hexRgb = (hex) => (/^#[0-9a-f]{6}$/iu.test(String(hex || "")) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);
// a colour lifted towards white until it reads on the dark card
function readable(rgb) {
  const light = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  let c = rgb.slice();
  for (let i = 0; i < 6 && light(c) < 120; i += 1) c = c.map((v) => Math.round(v + (255 - v) * 0.22));
  return c;
}
function brand(p) {
  const width = p.text("Anii", 64, 104, "title", COLORS.ink);
  p.text("Logs", 64 + width + 2, 104, "title", COLORS.mint);
}
// a pill on the top line, right-aligned at `right`; returns its left edge
function topPill(p, label, right, rgb) {
  const w = p.measure(label, "label", 2) + 44;
  p.pill(right - w, 62, w, 50, rgb, COLORS.paper, 3);
  p.text(label, right - w / 2, 95, "label", rgb === COLORS.soft ? COLORS.ink : rgb, { align: "center", spacing: 2 });
  return right - w;
}

// An Aniimo's card: its art on the left, the name, form, elements and role, a few facts and the Aniilog's own words on
// the right. model: { name, form ("Highland Form"), number ("#001"), elements: [{ label, color: "#e03d3d" }], role,
// facts: ["0.9 m · 12 kg"], description }; art: a decoded picture ({ width, height, rgba }) or null.
export async function drawAniimoCard(model, letters, art = null) {
  const p = background(await atlas(letters));
  p.extra = letters.extra || null;
  const W = CARD_WIDTH; const PAD = 64;
  brand(p);
  const number = String(model.number || "").replace(/[^0-9]/gu, "");
  topPill(p, number ? `ANIILOG ${number}` : "ANIILOG", W - PAD, COLORS.soft);
  // the art, in a panel
  const box = { x: PAD, y: 150, size: 416 };
  p.round(box.x, box.y, box.size, box.size, 32, COLORS.line);
  p.round(box.x + 2, box.y + 2, box.size - 4, box.size - 4, 30, COLORS.panel);
  const firstColor = readable(hexRgb(model.elements?.[0]?.color) || COLORS.mint);
  if (art) {
    const room = box.size - 40;
    const scale = Math.min(room / art.width, room / art.height);
    const w = Math.round(art.width * scale); const h = Math.round(art.height * scale);
    placeArt(p, art, box.x + Math.round((box.size - w) / 2), box.y + Math.round((box.size - h) / 2), w, h, COLORS.panel, 150);
  } else {                                               // no art in the release: the name's first letter
    const letter = [...cardText(model.name || "?")][0] || "?";
    p.round(box.x + 128, box.y + 128, 160, 160, 80, firstColor);
    p.round(box.x + 134, box.y + 134, 148, 148, 74, COLORS.panel);
    p.text(letter.toUpperCase(), box.x + box.size / 2, box.y + box.size / 2 + 19, "title", firstColor, { align: "center" });
  }
  // the name and form
  const left = box.x + box.size + 48; const room = W - PAD - left;
  const name = cardText(model.name || "Aniimo");
  p.text(name, left, 214, cardTitleFont((font) => p.measure(name, font), room), COLORS.ink, { max: room });
  if (model.form) p.text(cardText(model.form), left, 262, "body", COLORS.soft, { max: room });
  // elements and role as pills
  let x = left;
  const pills = [...(model.elements || []).map((element) => [cardText(element.label).toUpperCase(), readable(hexRgb(element.color) || COLORS.soft)]),
    ...(model.role ? [[cardText(model.role).toUpperCase(), COLORS.soft]] : [])];
  for (const [label, rgb] of pills) {
    const w = p.measure(label, "label", 2) + 40;
    if (x + w > W - PAD) break;
    p.pill(x, 292, w, 46, rgb, COLORS.paper, 3);
    p.text(label, x + w / 2, 323, "label", rgb === COLORS.soft ? COLORS.ink : rgb, { align: "center", spacing: 2 });
    x += w + 12;
  }
  // facts, then the Aniilog's description
  let y = 390;
  for (const fact of (model.facts || []).slice(0, 2)) {
    p.text(cardText(fact), left, y, "small", COLORS.soft, { max: room });
    y += 38;
  }
  p.fill(left, y - 14, room, 2, COLORS.line);
  y += 30;
  for (const line of wrapLines(p, model.description || "", "small", room, Math.max(1, Math.floor((582 - y) / 36) + 1))) {
    p.text(line, left, y, "small", COLORS.ink, { max: room });
    y += 36;
  }
  return p.png();
}
