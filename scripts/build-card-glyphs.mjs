// game-audit: n/a build script; draws the letters of the placement cards, no game data
// Builds src/card-glyphs.js: the letters the API draws placement cards with (src/placement-card.js), rasterised here
// once so the API only copies pixels. The letters are AniiLogs' own: a rounded monoline sans drawn from centre lines
// below (no font file, so no licence to carry). Each size is a set of glyphs with 4-bit coverage (16 grey levels),
// stored row by row as spans of one level, the whole atlas deflated and base64'd.
//   node scripts/build-card-glyphs.mjs          writes src/card-glyphs.js
//   node scripts/build-card-glyphs.mjs --check  fails when src/card-glyphs.js isn't what this script writes
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "src", "card-glyphs.js");

// ---------------------------------------------------------------- shapes (units: 1000 an em, y up, baseline 0)
const CAP = 700; const XH = 520; const ASC = 740; const DESC = -200;
const deg = Math.PI / 180;
function arc(cx, cy, rx, ry, from, to, steps = 0) {
  const n = steps || Math.max(6, Math.ceil(Math.abs(to - from) / 6));
  const points = [];
  for (let i = 0; i <= n; i += 1) {
    const a = (from + (to - from) * (i / n)) * deg;
    points.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return points;
}
function bezier(p0, p1, p2, p3, n = 24) {
  const points = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n; const u = 1 - t;
    points.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
  }
  return points;
}
const line = (...points) => points;
const join = (...parts) => parts.flat();
const dot = (x, y) => [[x, y], [x, y]];

// Each glyph: (m) => { w: the centre-line width, strokes, fill? }; m carries the stroke's half width h and the lines
// its centre runs along (B baseline, T cap top, X x-height, A ascender, D descender, M cap middle, XM x middle).
function glyphs() {
  const g = {};
  const box = (iw, draw) => (m) => {
    const x0 = m.side; const x1 = x0 + iw; const cx = (x0 + x1) / 2;
    return { advance: iw + 2 * m.side, ...draw({ ...m, x0, x1, cx, iw }) };
  };
  // capitals
  g.A = box(560, ({ x0, x1, cx, B, T }) => {
    const y = B + 0.3 * (T - B); const dx = (cx - x0) * (y - B) / (T - B);
    return { strokes: [line([x0, B], [cx, T], [x1, B]), line([x0 + dx, y], [x1 - dx, y])] };
  });
  g.B = box(440, ({ x0, x1, B, T, M }) => {
    const r1 = (T - M) / 2; const r2 = (M - B) / 2; const top = x1 - 40;
    return { strokes: [join(line([x0, B], [x0, T], [top - r1, T]), arc(top - r1, (T + M) / 2, r1, r1, 90, -90), line([x0, M], [x1 - r2, M]),
      arc(x1 - r2, (M + B) / 2, r2, r2, 90, -90), line([x0, B]))] };
  });
  g.C = box(520, ({ cx, iw, M, T, B }) => ({ strokes: [arc(cx, M, iw / 2, (T - B) / 2, 42, 318)] }));
  g.D = box(500, ({ x0, x1, B, T, M }) => {
    const r = Math.min((T - B) / 2, 300);
    return { strokes: [join(line([x0, B], [x0, T], [x1 - r, T]), arc(x1 - r, M, r, (T - B) / 2, 90, -90), line([x0, B]))] };
  });
  g.E = box(400, ({ x0, x1, B, T, M }) => ({ strokes: [line([x1, T], [x0, T], [x0, B], [x1, B]), line([x0, M], [x1 - 40, M])] }));
  g.F = box(380, ({ x0, x1, B, T, M }) => ({ strokes: [line([x1, T], [x0, T], [x0, B]), line([x0, M], [x1 - 50, M])] }));
  g.G = box(540, ({ cx, x1, iw, M, T, B }) => ({ strokes: [arc(cx, M, iw / 2, (T - B) / 2, 40, 360), line([cx + 30, M], [x1, M])] }));
  g.H = box(480, ({ x0, x1, B, T, M }) => ({ strokes: [line([x0, B], [x0, T]), line([x1, B], [x1, T]), line([x0, M], [x1, M])] }));
  g.I = box(0, ({ x0, B, T }) => ({ strokes: [line([x0, B], [x0, T])] }));
  g.J = box(380, ({ x1, iw, B, T }) => ({ strokes: [join(line([x1, T], [x1, B + iw / 2]), arc(x1 - iw / 2, B + iw / 2, iw / 2, iw / 2, 0, -180))] }));
  g.K = box(460, ({ x0, x1, B, T, M }) => {
    const end = [x0, M - 40]; const p = [x1 + (end[0] - x1) * 0.6, T + (end[1] - T) * 0.6];
    return { strokes: [line([x0, B], [x0, T]), line([x1, T], end), line(p, [x1, B])] };
  });
  g.L = box(380, ({ x0, x1, B, T }) => ({ strokes: [line([x0, T], [x0, B], [x1, B])] }));
  g.M = box(620, ({ x0, x1, cx, B, T }) => ({ strokes: [line([x0, B], [x0, T], [cx, B + 80], [x1, T], [x1, B])] }));
  g.N = box(500, ({ x0, x1, B, T }) => ({ strokes: [line([x0, B], [x0, T], [x1, B], [x1, T])] }));
  g.O = box(600, ({ cx, iw, M, T, B }) => ({ strokes: [arc(cx, M, iw / 2, (T - B) / 2, 0, 360)] }));
  const bowlP = ({ x0, x1, B, T, M }) => {
    const mid = M - 20; const r = (T - mid) / 2;
    return join(line([x0, B], [x0, T], [x1 - r, T]), arc(x1 - r, (T + mid) / 2, r, r, 90, -90), line([x0, mid]));
  };
  g.P = box(440, (m) => ({ strokes: [bowlP(m)] }));
  g.Q = box(600, ({ cx, x1, iw, M, T, B }) => ({ strokes: [arc(cx, M, iw / 2, (T - B) / 2, 0, 360), line([cx + 80, B + 170], [x1 + 30, B - 40])] }));
  g.R = box(440, (m) => ({ strokes: [bowlP(m), line([m.x0 + m.iw * 0.45, m.M - 20], [m.x1, m.B])] }));
  const ess = (cx, rx, top, bottom) => {
    const mid = (top + bottom) / 2;
    return join(arc(cx, (top + mid) / 2, rx * 0.94, (top - mid) / 2, 28, 270), arc(cx, (mid + bottom) / 2, rx, (mid - bottom) / 2, 90, -150));
  };
  g.S = box(440, ({ cx, iw, T, B }) => ({ strokes: [ess(cx, iw / 2, T, B)] }));
  g.T = box(480, ({ x0, x1, cx, B, T }) => ({ strokes: [line([x0, T], [x1, T]), line([cx, T], [cx, B])] }));
  g.U = box(480, ({ x0, x1, cx, iw, B, T }) => ({ strokes: [join(line([x0, T], [x0, B + iw / 2]), arc(cx, B + iw / 2, iw / 2, iw / 2, 180, 360), line([x1, T]))] }));
  g.V = box(540, ({ x0, x1, cx, B, T }) => ({ strokes: [line([x0, T], [cx, B], [x1, T])] }));
  g.W = box(760, ({ x0, x1, cx, iw, B, T }) => ({ strokes: [line([x0, T], [x0 + iw * 0.25, B], [cx, T - 60], [x0 + iw * 0.75, B], [x1, T])] }));
  g.X = box(500, ({ x0, x1, B, T }) => ({ strokes: [line([x0, T], [x1, B]), line([x1, T], [x0, B])] }));
  g.Y = box(520, ({ x0, x1, cx, B, T, M }) => ({ strokes: [line([x0, T], [cx, M - 20], [x1, T]), line([cx, M - 20], [cx, B])] }));
  g.Z = box(460, ({ x0, x1, B, T }) => ({ strokes: [line([x0, T], [x1, T], [x0, B], [x1, B])] }));
  // small letters
  const bowl = (cx, rx, m) => arc(cx, m.XM, rx, (m.X - m.B) / 2, 0, 360);
  g.a = box(440, (m) => ({ strokes: [bowl(m.x0 + m.iw / 2, m.iw / 2, m), line([m.x1, m.X], [m.x1, m.B])] }));
  g.b = box(440, (m) => ({ strokes: [line([m.x0, m.A], [m.x0, m.B]), bowl(m.x0 + m.iw / 2, m.iw / 2, m)] }));
  g.c = box(400, (m) => ({ strokes: [arc(m.cx, m.XM, m.iw / 2, (m.X - m.B) / 2, 45, 315)] }));
  g.d = box(440, (m) => ({ strokes: [bowl(m.x0 + m.iw / 2, m.iw / 2, m), line([m.x1, m.A], [m.x1, m.B])] }));
  g.e = box(440, (m) => ({ strokes: [join(line([m.x0, m.XM], [m.x1, m.XM]), arc(m.cx, m.XM, m.iw / 2, (m.X - m.B) / 2, 0, 318))] }));
  g.f = box(280, (m) => {
    const x = m.x0 + 70; const r = 120;
    return { strokes: [join(line([x, m.B], [x, m.A - r]), arc(x + r, m.A - r, r, r, 180, 55)), line([m.x0 - 20, m.X], [m.x1, m.X])] };
  });
  g.g = box(440, (m) => {
    const ry = 130;
    return { strokes: [bowl(m.x0 + m.iw / 2, m.iw / 2, m), join(line([m.x1, m.X], [m.x1, m.D + ry]), arc(m.cx, m.D + ry, m.iw / 2, ry, 0, -165))] };
  });
  const arch = (x0, x1, m) => {
    const r = (x1 - x0) / 2;
    return join(arc(x0 + r, m.X - r, r, r, 180, 0), line([x1, m.B]));
  };
  g.h = box(420, (m) => ({ strokes: [line([m.x0, m.A], [m.x0, m.B]), arch(m.x0, m.x1, m)] }));
  g.i = box(0, (m) => ({ strokes: [line([m.x0, m.X], [m.x0, m.B]), dot(m.x0, m.X + 200)] }));
  g.j = box(0, (m) => {
    const r = 120;
    return { strokes: [join(line([m.x0, m.X], [m.x0, m.D + r]), arc(m.x0 - r, m.D + r, r, r, 0, -150)), dot(m.x0, m.X + 200)] };
  });
  g.k = box(380, (m) => {
    const end = [m.x0, m.B + (m.X - m.B) * 0.3]; const p = [m.x1 + (end[0] - m.x1) * 0.55, m.X + (end[1] - m.X) * 0.55];
    return { strokes: [line([m.x0, m.A], [m.x0, m.B]), line([m.x1, m.X], end), line(p, [m.x1, m.B])] };
  });
  g.l = box(0, (m) => ({ strokes: [line([m.x0, m.A], [m.x0, m.B])] }));
  g.m = box(680, (m) => ({ strokes: [line([m.x0, m.X], [m.x0, m.B]), arch(m.x0, m.x0 + m.iw / 2, m), arch(m.x0 + m.iw / 2, m.x1, m)] }));
  g.n = box(420, (m) => ({ strokes: [line([m.x0, m.X], [m.x0, m.B]), arch(m.x0, m.x1, m)] }));
  g.o = box(440, (m) => ({ strokes: [bowl(m.cx, m.iw / 2, m)] }));
  g.p = box(440, (m) => ({ strokes: [line([m.x0, m.X], [m.x0, m.D]), bowl(m.x0 + m.iw / 2, m.iw / 2, m)] }));
  g.q = box(440, (m) => ({ strokes: [bowl(m.x0 + m.iw / 2, m.iw / 2, m), line([m.x1, m.X], [m.x1, m.D])] }));
  g.r = box(260, (m) => {
    const r = 190;
    return { strokes: [line([m.x0, m.X], [m.x0, m.B]), arc(m.x0 + r, m.X - r, r, r, 180, 70)] };
  });
  g.s = box(360, (m) => ({ strokes: [ess(m.cx, m.iw / 2, m.X, m.B)] }));
  g.t = box(280, (m) => {
    const x = m.x0 + 80; const r = 110;
    return { strokes: [join(line([x, m.A - 60], [x, m.B + r]), arc(x + r, m.B + r, r, r, 180, 285)), line([m.x0 - 20, m.X], [m.x1, m.X])] };
  });
  g.u = box(420, (m) => {
    const r = m.iw / 2;
    return { strokes: [join(line([m.x0, m.X], [m.x0, m.B + r]), arc(m.cx, m.B + r, r, r, 180, 360)), line([m.x1, m.X], [m.x1, m.B])] };
  });
  g.v = box(440, (m) => ({ strokes: [line([m.x0, m.X], [m.cx, m.B], [m.x1, m.X])] }));
  g.w = box(660, (m) => ({ strokes: [line([m.x0, m.X], [m.x0 + m.iw / 4, m.B], [m.cx, m.X - 40], [m.x0 + 3 * m.iw / 4, m.B], [m.x1, m.X])] }));
  g.x = box(420, (m) => ({ strokes: [line([m.x0, m.X], [m.x1, m.B]), line([m.x1, m.X], [m.x0, m.B])] }));
  g.y = box(440, (m) => {
    const low = [m.x0 + m.iw * 0.12, m.D]; const t = (m.X - m.B) / (m.X - low[1]);
    const meet = [m.x1 + (low[0] - m.x1) * t, m.B];
    return { strokes: [line([m.x1, m.X], low), line([m.x0, m.X], meet)] };
  });
  g.z = box(380, (m) => ({ strokes: [line([m.x0, m.X], [m.x1, m.X], [m.x0, m.B], [m.x1, m.B])] }));
  // figures: one width, so columns of numbers line up
  const fig = (draw) => box(440, draw);
  g["0"] = fig((m) => ({ strokes: [arc(m.cx, m.M, m.iw / 2, (m.T - m.B) / 2, 0, 360)] }));
  g["1"] = fig((m) => ({ strokes: [line([m.x0 + m.iw * 0.15, m.T - 140], [m.cx + 50, m.T], [m.cx + 50, m.B])] }));
  g["2"] = fig((m) => {
    const r = m.iw / 2;
    return { strokes: [join(arc(m.cx, m.T - r * 0.95, r, r * 0.95, 160, -32), line([m.x0, m.B], [m.x1 + 10, m.B]))] };
  });
  g["3"] = fig((m) => ({ strokes: [join(arc(m.cx, (m.T + m.M) / 2, m.iw / 2 * 0.9, (m.T - m.M) / 2, 150, -90), arc(m.cx, (m.M + m.B) / 2, m.iw / 2, (m.M - m.B) / 2, 90, -150))] }));
  g["4"] = fig((m) => {
    const y = m.B + (m.T - m.B) * 0.3;
    return { strokes: [line([m.x1 - 70, m.B], [m.x1 - 70, m.T], [m.x0, y], [m.x1 + 20, y])] };
  });
  g["5"] = fig((m) => {
    const top = m.M + 40; const ry = (top - m.B) / 2;
    return { strokes: [join(line([m.x1 - 10, m.T], [m.x0 + 30, m.T], [m.x0 + 10, top]), arc(m.cx, m.B + ry, m.iw / 2, ry, 135, -150))] };
  });
  g["6"] = fig((m) => {
    const ry = (m.M + 30 - m.B) / 2;
    return { strokes: [arc(m.cx, m.B + ry, m.iw / 2, ry, 0, 360), bezier([m.x0, m.B + ry], [m.x0, m.T - 60], [m.cx - 40, m.T], [m.x1 - 30, m.T - 30])] };
  });
  g["7"] = fig((m) => ({ strokes: [line([m.x0, m.T], [m.x1, m.T], [m.cx - 50, m.B])] }));
  g["8"] = fig((m) => ({ strokes: [arc(m.cx, (m.T + m.M) / 2, m.iw / 2 * 0.86, (m.T - m.M) / 2, 0, 360), arc(m.cx, (m.M + m.B) / 2, m.iw / 2, (m.M - m.B) / 2, 0, 360)] }));
  g["9"] = fig((m) => {
    const ry = (m.T - (m.M - 30)) / 2;
    return { strokes: [arc(m.cx, m.T - ry, m.iw / 2, ry, 0, 360), bezier([m.x1, m.T - ry], [m.x1, m.B + 60], [m.cx + 40, m.B], [m.x0 + 30, m.B + 30])] };
  });
  // marks
  g[" "] = () => ({ advance: 270, strokes: [] });
  g["."] = box(0, (m) => ({ strokes: [dot(m.x0, m.B)] }));
  g[","] = box(0, (m) => ({ strokes: [line([m.x0, m.B], [m.x0 - 40, m.B - 140])] }));
  g[":"] = box(0, (m) => ({ strokes: [dot(m.x0, m.B), dot(m.x0, m.X - 40)] }));
  g["-"] = box(220, (m) => ({ strokes: [line([m.x0, m.XM + 10], [m.x1, m.XM + 10])] }));
  g["–"] = box(440, (m) => ({ strokes: [line([m.x0, m.XM + 10], [m.x1, m.XM + 10])] }));
  g["·"] = box(0, (m) => ({ strokes: [dot(m.x0, m.XM + 30)] }));
  g["+"] = box(380, (m) => ({ strokes: [line([m.x0, m.XM + 20], [m.x1, m.XM + 20]), line([m.cx, m.XM - 170], [m.cx, m.XM + 210])] }));
  g["/"] = box(320, (m) => ({ strokes: [line([m.x0, m.B - 60], [m.x1, m.T + 20])] }));
  g["("] = box(150, (m) => ({ strokes: [arc(m.x0 + 380, m.M, 380, (m.T - m.B) / 2 + 110, 128, 232)] }));
  g[")"] = box(150, (m) => ({ strokes: [arc(m.x1 - 380, m.M, 380, (m.T - m.B) / 2 + 110, 52, -52)] }));
  g["'"] = box(0, (m) => ({ strokes: [line([m.x0, m.T], [m.x0, m.T - 190])] }));
  g["_"] = box(440, (m) => ({ strokes: [line([m.x0, m.B - 80], [m.x1, m.B - 80])] }));
  g["!"] = box(0, (m) => ({ strokes: [line([m.x0, m.T], [m.x0, m.B + 230]), dot(m.x0, m.B)] }));
  g["?"] = box(380, (m) => {
    const r = m.iw / 2;
    return { strokes: [join(arc(m.cx, m.T - r * 0.9, r, r * 0.9, 160, -70), line([m.cx, m.M - 60], [m.cx, m.B + 230])), dot(m.cx, m.B)] };
  });
  g["#"] = box(480, (m) => ({ strokes: [line([m.x0 + m.iw * 0.28, m.B], [m.x0 + m.iw * 0.44, m.T]), line([m.x0 + m.iw * 0.62, m.B], [m.x0 + m.iw * 0.78, m.T]),
    line([m.x0 + 10, m.M + 120], [m.x1, m.M + 120]), line([m.x0, m.M - 120], [m.x1 - 10, m.M - 120])] }));
  g["★"] = box(600, (m) => {
    const cx = m.cx; const cy = m.XM + 70; const points = [];
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 ? 128 : 320; const a = (90 + i * 36) * deg;
      points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return { strokes: [], fill: points };
  });
  // accents, drawn over a letter (".l" over small letters, ".u" over capitals); no advance of their own
  const accents = {
    acute: (x, y) => [line([x - 40, y], [x + 70, y + 130])],
    grave: (x, y) => [line([x + 40, y], [x - 70, y + 130])],
    circumflex: (x, y) => [line([x - 110, y], [x, y + 120], [x + 110, y])],
    diaeresis: (x, y) => [dot(x - 100, y + 50), dot(x + 100, y + 50)],
    tilde: (x, y) => [bezier([x - 130, y + 20], [x - 60, y + 140], [x + 60, y - 40], [x + 130, y + 80], 16)],
    ring: (x, y) => [arc(x, y + 75, 70, 70, 0, 360)],
  };
  for (const [name, draw] of Object.entries(accents)) {
    g[`${name}.l`] = (m) => ({ advance: 0, strokes: draw(0, m.X + m.h + 90) });
    g[`${name}.u`] = (m) => ({ advance: 0, strokes: draw(0, m.T + m.h + 70) });
  }
  return g;
}

// ---------------------------------------------------------------- rasterising
// A pixel's coverage: how many of its 4x4 samples are within the stroke's half width of a centre line, or inside a fill.
function rasterise(shape, size, h) {
  const scale = size / 1000;
  const segments = [];
  for (const stroke of shape.strokes) {
    for (let i = 0; i < stroke.length - 1; i += 1) segments.push([...stroke[i], ...stroke[i + 1]]);
    if (stroke.length === 1) segments.push([...stroke[0], ...stroke[0]]);
  }
  const fill = shape.fill || null;
  const xs = []; const ys = [];
  for (const [x1, y1, x2, y2] of segments) { xs.push(x1 - h, x2 - h, x1 + h, x2 + h); ys.push(y1 - h, y2 - h, y1 + h, y2 + h); }
  for (const [x, y] of fill || []) { xs.push(x); ys.push(y); }
  if (!xs.length) return { left: 0, top: 0, width: 0, height: 0, cells: new Uint8Array(0) };
  const left = Math.floor(Math.min(...xs) * scale) - 1; const right = Math.ceil(Math.max(...xs) * scale) + 1;
  const top = Math.floor(-Math.max(...ys) * scale) - 1; const bottom = Math.ceil(-Math.min(...ys) * scale) + 1;
  const width = right - left; const height = bottom - top;
  const cells = new Uint8Array(width * height);
  const h2 = h * h;
  const near = (x, y) => {
    for (const [x1, y1, x2, y2] of segments) {
      const dx = x2 - x1; const dy = y2 - y1; const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
      const ex = x1 + t * dx - x; const ey = y1 + t * dy - y;
      if (ex * ex + ey * ey <= h2) return true;
    }
    return false;
  };
  const inside = (x, y) => {
    if (!fill) return false;
    let hit = false;
    for (let i = 0, j = fill.length - 1; i < fill.length; j = i, i += 1) {
      const [xi, yi] = fill[i]; const [xj, yj] = fill[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      let count = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const ux = (left + col + (sx + 0.5) / 4) / scale; const uy = -(top + row + (sy + 0.5) / 4) / scale;
          if (near(ux, uy) || inside(ux, uy)) count += 1;
        }
      }
      cells[row * width + col] = Math.round((count * 15) / 16);
    }
  }
  return { left, top, width, height, cells };
}

// ---------------------------------------------------------------- the sizes the card uses
const ALL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:-–·+/()'_!?#★";
const ACCENTS = ["acute", "grave", "circumflex", "diaeresis", "tilde", "ring"].flatMap((name) => [`${name}.l`, `${name}.u`]);
// weight: the stroke's half width in units (bold 68, regular 44); letters: what that size needs
export const CARD_FONT_SPECS = Object.freeze({
  place: { size: 150, weight: 70, letters: "#0123456789" },
  figure: { size: 100, weight: 66, letters: "0123456789,.:–- " },
  title: { size: 54, weight: 66, letters: ALL, accents: true },
  body: { size: 36, weight: 62, letters: ALL, accents: true },
  small: { size: 28, weight: 46, letters: ALL, accents: true },
  label: { size: 22, weight: 64, letters: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -·" },
});

export function buildAtlas() {
  const shapes = glyphs();
  const fonts = {};
  const chunks = [];
  let offset = 0;
  for (const [name, spec] of Object.entries(CARD_FONT_SPECS)) {
    const h = spec.weight;
    const metrics = { h, side: 50 + h, B: h, T: CAP - h, X: XH - h, A: ASC - h, D: DESC + h, M: CAP / 2, XM: XH / 2 };
    const keys = [...new Set([...spec.letters])].concat(spec.accents ? ACCENTS : []);
    const table = {};
    for (const key of keys) {
      const shape = shapes[key](metrics);
      const bitmap = rasterise(shape, spec.size, h);
      if (bitmap.width > 255 || bitmap.height > 255) throw new Error(`Glyph ${key} at ${spec.size}px is too big for the span format.`);
      // each row as spans of one coverage level: [count, then x, length, level for each]; empty pixels have no span,
      // so the API fills a letter's inside in one go and only blends its edges
      const bytes = [];
      for (let row = 0; row < bitmap.height; row += 1) {
        const spans = [];
        for (let col = 0; col < bitmap.width;) {
          const level = bitmap.cells[row * bitmap.width + col];
          let end = col + 1;
          while (end < bitmap.width && bitmap.cells[row * bitmap.width + end] === level) end += 1;
          if (level) spans.push(col, end - col, level);
          col = end;
        }
        bytes.push(spans.length / 3, ...spans);
      }
      // [advance in 1/16 px, left, top, width, height, byte offset]
      table[key] = [Math.round((shape.advance * spec.size) / 1000 * 16), bitmap.left, bitmap.top, bitmap.width, bitmap.height, offset];
      chunks.push(Uint8Array.from(bytes));
      offset += bytes.length;
    }
    fonts[name] = { size: spec.size, capHeight: Math.round((CAP * spec.size) / 1000), xHeight: Math.round((XH * spec.size) / 1000), glyphs: table };
  }
  const atlas = new Uint8Array(offset);
  let at = 0;
  for (const chunk of chunks) { atlas.set(chunk, at); at += chunk.length; }
  return { fonts, atlas };
}

function moduleText({ fonts, atlas }) {
  const data = deflateRawSync(atlas, { level: 9 }).toString("base64");
  const lines = data.match(/.{1,160}/gu) || [];
  return `// game-audit: n/a generated by scripts/build-card-glyphs.mjs; the placement cards' letters, no game data\n`
    + "// Generated: do not edit. AniiLogs' own monoline letters, rasterised with 4-bit coverage, each row as spans of one\n"
    + "// level ([count, then x, length, level each]), deflated (raw) and base64'd. Each glyph: [advance in 1/16 px, left,\n// top, width, height, byte offset].\n"
    + `export const CARD_ATLAS_BYTES = ${atlas.length};\n`
    + `export const CARD_FONTS = ${JSON.stringify(fonts)};\n`
    + `export const CARD_ATLAS = ${lines.map((part) => JSON.stringify(part)).join("\n  + ")};\n`;
}

const text = moduleText(buildAtlas());
if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current.replaceAll("\r\n", "\n") !== text) throw new Error("src/card-glyphs.js is out of date: run node scripts/build-card-glyphs.mjs");
  console.log(JSON.stringify({ status: "pass", bytes: text.length }));
} else {
  await writeFile(output, text, "utf8");
  console.log(JSON.stringify({ status: "written", output, bytes: text.length }));
}
