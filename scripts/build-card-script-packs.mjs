// game-audit: n/a build script; draws the placement cards' letters for other scripts, no game data
// The placement cards' letters beyond their own Latin set (src/card-glyphs.js): Chinese, Japanese, Korean, Cyrillic,
// Greek, more Latin, fullwidth forms and common symbols, drawn ahead of time into "packs" the API reads from R2 when a
// name needs them (src/placement-links.js). One pack per 256 code points; only letters the fonts really have.
//
// Fonts (SIL Open Font License 1.1, https://openfontlicense.org): Noto Sans CJK (Copyright 2014-2021 Adobe,
// https://github.com/notofonts/noto-cjk) and Noto Sans (Copyright 2022 The Noto Project Authors,
// https://github.com/notofonts/latin-greek-cyrillic). The packs are pictures of their letters made under that licence;
// they are not sold, and the fonts themselves are neither kept in this repository nor sent anywhere.
//
//   node scripts/build-card-script-packs.mjs --cjk <NotoSansCJK-Bold.ttc> --sans <NotoSans-Bold.ttf> --out <folder>
//        --chrome <chrome.exe> [--blocks 4e00,ac00]          draws the packs (a headless browser does the drawing)
//   node scripts/build-card-script-packs.mjs --check --out <folder>     reads every pack back and lists them
//
// Pack format (then deflated, raw): "ACP1", u8 format version (1), u8 pixel size, u16 letter count, then per letter
// 12 bytes: u8 code point's low byte, u8 0, u16 advance in 1/16 px, i8 left, i8 top (from the baseline, up is
// negative), u8 width, u8 height, u32 byte offset in the pictures; then the pictures, 4-bit coverage, two pixels a
// byte (high nibble first), each letter from a byte boundary. Stored as card-glyphs/v1/<block>.bin, block = the first
// code point in 4 hex digits (e.g. 4e00). Fonts and pages are read as data only; nothing in the font folders is run.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

const args = Object.fromEntries(process.argv.slice(2).reduce((list, arg, i, all) => (arg.startsWith("--")
  ? [...list, [arg.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : list), []));
const repo = resolve(import.meta.dirname, "..");
if (!args.out || args.out === true) throw new Error("--out <folder> (outside the repository) is required");
const out = resolve(String(args.out));
if (out.toLowerCase().startsWith(repo.toLowerCase())) throw new Error("The packs are written outside the repository.");

// the letters' size: the card draws names at 36 px; CJK is drawn a little smaller so it stands as tall as the capitals
export const PACK_SIZES = Object.freeze({ cjk: 32, sans: 35 });
// which code points, and from which font (the first that has the letter)
const RANGES = [
  [0x00a0, 0x02ff, ["sans", "cjk"]], [0x0370, 0x03ff, ["sans", "cjk"]], [0x0400, 0x052f, ["sans", "cjk"]],
  [0x1e00, 0x1eff, ["sans", "cjk"]], [0x1100, 0x11ff, ["cjk"]], [0x2000, 0x27bf, ["sans", "cjk"]],
  [0x2e80, 0x33ff, ["cjk"]], [0x3400, 0x4dbf, ["cjk"]], [0x4e00, 0x9fff, ["cjk"]], [0xa960, 0xa97f, ["cjk"]],
  [0xac00, 0xd7af, ["cjk"]], [0xf900, 0xfaff, ["cjk"]], [0xfe30, 0xfe4f, ["cjk"]], [0xff00, 0xffef, ["cjk"]],
];

export function readPack(bytes) {
  const data = inflateRawSync(bytes);
  if (data.toString("latin1", 0, 4) !== "ACP1" || data[4] !== 1) throw new Error("not a card letter pack");
  const count = data.readUInt16LE(6);
  const letters = [];
  for (let i = 0; i < count; i += 1) {
    const at = 8 + i * 12;
    letters.push({ low: data[at], advance: data.readUInt16LE(at + 2), left: data.readInt8(at + 4), top: data.readInt8(at + 5),
      width: data[at + 6], height: data[at + 7], offset: data.readUInt32LE(at + 8) });
  }
  return { size: data[5], letters, pictures: data.length - (8 + count * 12) };
}

if (args.check) {
  let total = 0; let letters = 0;
  const names = readdirSync(out).filter((name) => /^[0-9a-f]{2}00\.bin$/u.test(name)).sort();
  for (const name of names) {
    const bytes = readFileSync(join(out, name));
    total += bytes.length; letters += readPack(bytes).letters.length;
  }
  console.log(JSON.stringify({ status: names.length ? "pass" : "empty", packs: names.length, letters, bytes: total }));
  process.exit(names.length ? 0 : 1);
}

// ---------------------------------------------------------------- reading the fonts (tables only)
function tables(buf, base = 0) {
  const count = buf.readUInt16BE(base + 4);
  const list = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = base + 12 + i * 16;
    list.set(buf.toString("latin1", at, at + 4), { checksum: buf.readUInt32BE(at + 4), offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) });
  }
  return list;
}
function familyName(buf, table) {
  const at = table.offset; const count = buf.readUInt16BE(at + 2); const strings = at + buf.readUInt16BE(at + 4);
  for (let i = 0; i < count; i += 1) {
    const rec = at + 6 + i * 12;
    const [platform, , language, id] = [0, 2, 4, 6].map((o) => buf.readUInt16BE(rec + o));
    if (id === 4 && platform === 3 && language === 0x409) {
      const len = buf.readUInt16BE(rec + 8); const off = strings + buf.readUInt16BE(rec + 10);
      let text = ""; for (let k = 0; k < len; k += 2) text += String.fromCharCode(buf.readUInt16BE(off + k));
      return text;
    }
  }
  return "";
}
// one face of a TrueType/OpenType collection as a font file of its own (the browser reads single fonts)
function faceOf(buf, want) {
  if (buf.toString("latin1", 0, 4) !== "ttcf") return { font: buf, name: familyName(buf, tables(buf).get("name")) };
  const faces = buf.readUInt32BE(8);
  for (let f = 0; f < faces; f += 1) {
    const base = buf.readUInt32BE(12 + f * 4);
    const list = tables(buf, base);
    const name = familyName(buf, list.get("name"));
    if (!name.includes(want)) continue;
    const tags = [...list.keys()].sort();
    const header = Buffer.alloc(12 + tags.length * 16);
    buf.copy(header, 0, base, base + 12);
    let offset = header.length; const parts = [header];
    tags.forEach((tag, i) => {
      const { offset: from, length } = list.get(tag);
      const padded = Buffer.alloc((length + 3) & ~3);
      buf.copy(padded, 0, from, from + length);
      const rec = 12 + i * 16;
      header.write(tag, rec, "latin1"); header.writeUInt32BE(list.get(tag).checksum, rec + 4);
      header.writeUInt32BE(offset, rec + 8); header.writeUInt32BE(length, rec + 12);
      parts.push(padded); offset += padded.length;
    });
    return { font: Buffer.concat(parts), name };
  }
  throw new Error(`no face named like "${want}" in the collection`);
}
// the code points a font has (cmap formats 4 and 12)
function codePoints(buf) {
  const cmap = tables(buf).get("cmap").offset;
  const subtables = buf.readUInt16BE(cmap + 2);
  const found = new Set();
  for (let i = 0; i < subtables; i += 1) {
    const platform = buf.readUInt16BE(cmap + 4 + i * 8); const encoding = buf.readUInt16BE(cmap + 6 + i * 8);
    if (platform !== 3 || (encoding !== 1 && encoding !== 10)) continue;
    const at = cmap + buf.readUInt32BE(cmap + 8 + i * 8);
    const format = buf.readUInt16BE(at);
    if (format === 4) {
      const segs = buf.readUInt16BE(at + 6) / 2;
      for (let s = 0; s < segs; s += 1) {
        const end = buf.readUInt16BE(at + 14 + s * 2); const start = buf.readUInt16BE(at + 16 + segs * 2 + s * 2);
        const delta = buf.readInt16BE(at + 16 + segs * 4 + s * 2); const rangeAt = at + 16 + segs * 6 + s * 2; const range = buf.readUInt16BE(rangeAt);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          const glyph = range ? buf.readUInt16BE(rangeAt + range + (c - start) * 2) : (c + delta) & 0xffff;
          if (glyph) found.add(c);
        }
      }
    } else if (format === 12) {
      const groups = buf.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g += 1) {
        const start = buf.readUInt32BE(at + 16 + g * 12); const end = buf.readUInt32BE(at + 20 + g * 12);
        if (buf.readUInt32BE(at + 24 + g * 12)) for (let c = start; c <= end; c += 1) found.add(c);
      }
    }
  }
  return found;
}

if (!args.cjk || !args.sans) throw new Error("--cjk <NotoSansCJK-Bold.ttc> and --sans <NotoSans-Bold.ttf> are required");
const fonts = { cjk: faceOf(readFileSync(String(args.cjk)), "CJK SC"), sans: faceOf(readFileSync(String(args.sans)), "Noto Sans") };
const has = { cjk: codePoints(fonts.cjk.font), sans: codePoints(fonts.sans.font) };
const onlyBlocks = typeof args.blocks === "string" ? new Set(args.blocks.split(",").map((block) => parseInt(block, 16))) : null;
const plan = new Map();                                  // block -> [[code point, font]]
for (const [from, to, order] of RANGES) {
  for (let cp = from; cp <= to; cp += 1) {
    const font = order.find((name) => has[name].has(cp));
    const block = cp & 0xff00;
    if (!font || (onlyBlocks && !onlyBlocks.has(block))) continue;
    if (!plan.has(block)) plan.set(block, []);
    plan.get(block).push([cp, font]);
  }
}
console.error(`faces: ${fonts.cjk.name} / ${fonts.sans.name}; ${plan.size} packs, ${[...plan.values()].reduce((n, list) => n + list.length, 0)} letters`);

// ---------------------------------------------------------------- drawing, in a headless browser
const PAGE = `<!doctype html><meta charset="utf-8"><canvas id="c" width="96" height="96"></canvas><script>
(async () => {
  const sizes = ${JSON.stringify(PACK_SIZES)};
  for (const name of ["cjk", "sans"]) { const face = new FontFace("pack-" + name, "url(/" + name + ".font)"); await face.load(); document.fonts.add(face); }
  const plan = await (await fetch("/plan")).json();
  const ctx = document.getElementById("c").getContext("2d", { willReadFrequently: true });
  const X = 24, Y = 66;
  for (const [block, letters] of plan) {
    const out = [];
    for (const [cp, font] of letters) {
      ctx.clearRect(0, 0, 96, 96);
      ctx.font = sizes[font] + 'px "pack-' + font + '"';
      ctx.fillStyle = "#fff";
      const text = String.fromCodePoint(cp);
      ctx.fillText(text, X, Y);
      const advance = ctx.measureText(text).width;
      const px = ctx.getImageData(0, 0, 96, 96).data;
      let x0 = 96, y0 = 96, x1 = -1, y1 = -1;
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) if (px[(y * 96 + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const cells = [];
      if (x1 >= 0) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.push(Math.round(px[(y * 96 + x) * 4 + 3] * 15 / 255).toString(16));
      out.push([cp, Math.round(advance * 16), x1 >= 0 ? x0 - X : 0, x1 >= 0 ? y0 - Y : 0, x1 >= 0 ? x1 - x0 + 1 : 0, x1 >= 0 ? y1 - y0 + 1 : 0, cells.join("")]);
    }
    await fetch("/pack/" + block, { method: "POST", body: JSON.stringify(out) });
  }
  await fetch("/done", { method: "POST" });
})().catch((e) => fetch("/fail", { method: "POST", body: String(e && e.stack || e) }));
</script>`;

function pack(letters, size) {
  const head = Buffer.alloc(8 + letters.length * 12);
  head.write("ACP1", 0, "latin1"); head[4] = 1; head[5] = size; head.writeUInt16LE(letters.length, 6);
  const pictures = []; let offset = 0;
  letters.forEach(([cp, advance, left, top, width, height, cells], i) => {
    const at = 8 + i * 12;
    head[at] = cp & 0xff; head.writeUInt16LE(Math.min(65535, advance), at + 2); head.writeInt8(left, at + 4); head.writeInt8(top, at + 5);
    head[at + 6] = width; head[at + 7] = height; head.writeUInt32LE(offset, at + 8);
    const bytes = Buffer.alloc(Math.ceil((width * height) / 2));
    for (let k = 0; k < width * height; k += 1) bytes[k >> 1] |= k & 1 ? parseInt(cells[k], 16) : parseInt(cells[k], 16) << 4;
    pictures.push(bytes); offset += bytes.length;
  });
  return deflateRawSync(Buffer.concat([head, ...pictures]), { level: 9 });
}

mkdirSync(out, { recursive: true });
const manifest = [];
const chrome = String(args.chrome && args.chrome !== true ? args.chrome : process.env.CHROME_PATH || "");
if (!chrome) throw new Error("--chrome <path to a Chrome or Edge executable> (or CHROME_PATH) is required: it draws the letters");
const profile = join(tmpdir(), `card-packs-${process.pid}`);
const done = new Promise((resolveDone, rejectDone) => {
  const server = createServer((req, res) => {
    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(body).toString("utf8");
      if (req.url === "/") { res.setHeader("content-type", "text/html"); return res.end(PAGE); }
      if (req.url === "/plan") return res.end(JSON.stringify([...plan].map(([block, list]) => [block, list])));
      if (req.url === "/cjk.font") return res.end(fonts.cjk.font);
      if (req.url === "/sans.font") return res.end(fonts.sans.font);
      const packMatch = /^\/pack\/(\d+)$/u.exec(req.url);
      if (packMatch) {
        const block = Number(packMatch[1]);
        const letters = JSON.parse(text);
        // each cell one hex digit: the coverage 0-15
        const size = plan.get(block).some(([, font]) => font === "sans") ? PACK_SIZES.sans : PACK_SIZES.cjk;
        const bytes = pack(letters, size);
        const name = `${block.toString(16).padStart(4, "0")}.bin`;
        writeFileSync(join(out, name), bytes);
        manifest.push({ name, letters: letters.length, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        process.stderr.write(".");
        return res.end("ok");
      }
      if (req.url === "/done") { res.end("ok"); server.close(); return resolveDone(); }
      if (req.url === "/fail") { res.end("ok"); server.close(); return rejectDone(new Error(text)); }
      res.statusCode = 404; return res.end();
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const browser = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: "ignore" });
    done.finally(() => browser.kill()).catch(() => {});
  });
});
await done;
try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* the browser still holds it: the system cleans its temp folder */ }
manifest.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(out, "manifest.json"), JSON.stringify({ faces: [fonts.cjk.name, fonts.sans.name], sizes: PACK_SIZES, packs: manifest }, null, 1));
console.log(JSON.stringify({ status: "written", out, packs: manifest.length, letters: manifest.reduce((n, p) => n + p.letters, 0),
  bytes: manifest.reduce((n, p) => n + p.bytes, 0) }));
