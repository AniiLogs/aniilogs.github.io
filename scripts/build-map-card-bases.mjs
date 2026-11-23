// game-audit: n/a build script; shrinks the content release's own map pictures for the map link cards, no game data in it
// Builds the map pictures the map pin link cards are drawn on (src/placement-card.js drawMapCard, src/map-links.js):
// each map's full picture from the content release, shrunk to half the card's map room (MAP_CARD_BOX; the card draws
// it doubled, MAP_BASE_SCALE), laid on the card's panel colour and cut to 160 colours, saved as a palette PNG. The
// API copies those pixels as they are, so a card costs it a few milliseconds, not the seconds a full map would take.
//   node scripts/build-map-card-bases.mjs <out folder> [--only map-id,map-id] [--api https://aniilogs-api.pages.dev]
// The pictures are game art: keep the folder outside the repository. tools/upload-map-card-bases.mjs sends them to R2.
// Reads the release read-only, from the public content route.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { decodePng, MAP_BASE_SCALE, MAP_CARD_BOX, medianCut } from "../src/placement-card.js";

const root = resolve(import.meta.dirname, "..");
const release = /const CONTENT_RELEASE = "(\d+)"/u.exec(readFileSync(resolve(root, "src", "index.js"), "utf8"))?.[1];
const [folder, ...rest] = process.argv.slice(2);
const option = (name) => { const at = rest.indexOf(name); return at >= 0 ? String(rest[at + 1] || "") : ""; };
const api = (option("--api") || "https://aniilogs-api.pages.dev").replace(/\/+$/u, "");
const only = option("--only") ? new Set(option("--only").split(",")) : null;
if (!folder || !release) {
  console.error("usage: node scripts/build-map-card-bases.mjs <out folder> [--only map-id,map-id] [--api <origin>]");
  process.exit(1);
}
const base = `${api}/api/content/releases/${release}`;
const PANEL = [18, 29, 33];                            // the card's panel colour (src/placement-card.js COLORS.panel)
const COLOURS = 160;

// the box average of the picture over each output pixel, laid on the panel colour
function shrink(picture, width, height) {
  const { width: sw, height: sh, rgba } = picture;
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * sh) / height); const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * sw) / width); const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * sw + sx) * 4; const a = rgba[i + 3] / 255;
          r += rgba[i] * a + PANEL[0] * (1 - a); g += rgba[i + 1] * a + PANEL[1] * (1 - a); b += rgba[i + 2] * a + PANEL[2] * (1 - a); n += 1;
        }
      }
      const o = (y * width + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}

// cut to the palette, each pixel its nearest colour (no dithering: the card draws the picture doubled, where dither
// grain shows and packs worse)
function toPalette(rgb, width, height) {
  const colours = new Uint32Array(32768);
  for (let i = 0; i < rgb.length; i += 3) colours[((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3)] += 1;
  const palette = medianCut(colours, COLOURS);
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i += 1) {
    const r = rgb[i * 3]; const g = rgb[i * 3 + 1]; const b = rgb[i * 3 + 2];
    let best = Infinity;
    palette.forEach(([pr, pg, pb], k) => { const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2; if (d < best) { best = d; indices[i] = k; } });
  }
  return { palette, indices };
}

function pngOf(width, height, palette, indices) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes) => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(data)]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 3, 0, 0, 0], 8);
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("PLTE", Buffer.from(palette.flat())),
    chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const out = resolve(folder, release);
if (!existsSync(out)) mkdirSync(out, { recursive: true });
const site = await (await fetch(`${base}/data/map_site_data.json`)).json();
let made = 0;
for (const map of site.maps || []) {
  if (only && !only.has(map.id)) continue;
  if (!/^[a-z0-9-]{1,80}$/u.test(String(map.id)) || !map.fallback_image) { console.log(`${map.id}: no full picture, skipped`); continue; }
  const response = await fetch(`${base}/${String(map.fallback_image).replace(/^\.\//u, "")}`);
  if (!response.ok) { console.log(`${map.id}: ${response.status}, skipped`); continue; }
  const picture = await decodePng(new Uint8Array(await response.arrayBuffer()), { inflate: (bytes) => inflateSync(bytes), maxPixels: 16384 * 16384 });
  const scale = Math.min(Math.floor(MAP_CARD_BOX.width / MAP_BASE_SCALE) / picture.width, Math.floor(MAP_CARD_BOX.height / MAP_BASE_SCALE) / picture.height);
  const width = Math.max(1, Math.round(picture.width * scale)); const height = Math.max(1, Math.round(picture.height * scale));
  const { palette, indices } = toPalette(shrink(picture, width, height), width, height);
  const png = pngOf(width, height, palette, indices);
  writeFileSync(join(out, `${map.id}.png`), png);
  made += 1;
  console.log(`${map.id}: ${picture.width}x${picture.height} -> ${width}x${height}, ${palette.length} colours, ${(png.length / 1024).toFixed(0)} KB`);
}
console.log(`made ${made} map pictures in ${out}`);
