// game-audit: n/a the audit-tag checker itself
// Lists the site code whose content comes from the game and when each part was last checked against the game files.
// Every such file carries one tag line near the top (within its first 30 lines), never shown to players:
//   // game-audit: <game version> <YYYY-MM-DD | undated> <what was checked>   e.g. 1.1.3857679 2026-11-03 formulas 3001, 3512
//   // game-audit: unaudited <what in it comes from the game>
//   // game-audit: n/a <why a file that looks game-related isn't>
// Usage: node scripts/check-game-audit.mjs [--strict]
// The installed game version comes from ANIIMO_GAME_DIR (default: the Steam install) Aniimo_Data/cvs/res/lua/LuaCacheVer.txt,
// or else the newest builds/<version> folder under ANIIMO_GAME_MAP (the game-files map). With neither, the version
// comparison is skipped. --strict exits 1 when a tag is older than the installed game, unaudited, or missing.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const SCAN = ["public", "src", "scripts", "tools"];
const SKIP_DIRS = new Set(["node_modules", "vendor", ".git", ".wrangler", ".pages-api-dist", "assets", "data"]);
const DEFAULT_GAME_DIR = "C:/Program Files (x86)/Steam/steamapps/common/Aniimo";
export const TAG = /^\s*(?:\/\/|#|<!--)\s*game-audit:\s*(\S+)(?:\s+(.*?))?\s*(?:-->)?\s*$/u;
// Words that mark a file as built from the game's files or data.
export const GAME_HINTS = /formula_data|formula [0-9]{4}|pmdata|LuaScripts|\.lua\b|property_data|pet_data|bossrush_|rogue_[a-z]+_data|_calc_value_data|core_carry|pet_resonance|scene_[a-z]+_data|game files|game's (?:own )?(?:scripts|files|data|tables|code)|build [0-9]{7}/iu;

export function sourceFiles(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path);
      } else if (/\.(?:js|mjs|cjs|py)$/u.test(name)) {
        out.push(path);
      }
    }
  };
  for (const top of SCAN) if (existsSync(join(root, top))) walk(join(root, top));
  return out.sort();
}

// { kind: "audited" | "unaudited" | "n/a" | "invalid", version, build, date, what, line }
export function readTag(text) {
  const lines = text.split(/\r?\n/u).slice(0, 30);
  for (const [index, line] of lines.entries()) {
    const match = TAG.exec(line);
    if (!match) continue;
    const [, first, rest = ""] = match;
    if (first === "unaudited" || first === "n/a") return { kind: first, what: rest, line: index + 1 };
    const [date = "", ...what] = rest.split(/\s+/u);
    const build = Number(/([0-9]{6,})$/u.exec(first)?.[1]);
    if (!Number.isFinite(build) || !/^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|undated)$/u.test(date) || !what.length) {
      return { kind: "invalid", what: line.trim(), line: index + 1 };
    }
    return { kind: "audited", version: first, build, date, what: what.join(" "), line: index + 1 };
  }
  return null;
}

export function installedGame(env = process.env) {
  const gameDir = env.ANIIMO_GAME_DIR || DEFAULT_GAME_DIR;
  const cacheVer = join(gameDir, "Aniimo_Data", "cvs", "res", "lua", "LuaCacheVer.txt");
  if (existsSync(cacheVer)) {
    const version = readFileSync(cacheVer, "utf8").split(",")[0].trim();
    const build = Number(/([0-9]{6,})$/u.exec(version)?.[1]);
    if (Number.isFinite(build)) return { version, build, source: "LuaCacheVer.txt" };
  }
  const builds = env.ANIIMO_GAME_MAP ? join(env.ANIIMO_GAME_MAP, "builds") : null;
  if (builds && existsSync(builds)) {
    const newest = readdirSync(builds).filter((name) => /^[0-9]{6,}$/u.test(name)).map(Number).sort((a, b) => b - a)[0];
    if (newest) return { version: String(newest), build: newest, source: "game-files map" };
  }
  return null;
}

export function audit(root = ROOT, game = installedGame()) {
  const rows = sourceFiles(root).map((path) => {
    const text = readFileSync(path, "utf8");
    return { file: relative(root, path).replaceAll("\\", "/"), tag: readTag(text), gameDerived: GAME_HINTS.test(text) };
  });
  return {
    game,
    current: rows.filter((row) => row.tag?.kind === "audited" && (!game || row.tag.build === game.build)),
    stale: game ? rows.filter((row) => row.tag?.kind === "audited" && row.tag.build !== game.build) : [],
    unaudited: rows.filter((row) => row.tag?.kind === "unaudited"),
    invalid: rows.filter((row) => row.tag?.kind === "invalid"),
    untagged: rows.filter((row) => !row.tag && row.gameDerived),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const strict = process.argv.includes("--strict");
  const result = audit();
  const say = (title, rows, show) => {
    console.log(`${title} (${rows.length})`);
    for (const row of rows) console.log(`  ${row.file}${show ? `: ${show(row)}` : ""}`);
  };
  console.log(result.game
    ? `Installed game: ${result.game.version} (from ${result.game.source})`
    : "Skipped the version check: no game install (ANIIMO_GAME_DIR) or game-files map (ANIIMO_GAME_MAP) found.");
  say("Audited against the installed game", result.current, (row) => `${row.tag.version} ${row.tag.date}`);
  say("Audited against an older game version", result.stale, (row) => `${row.tag.version} ${row.tag.date} ${row.tag.what}`);
  say("Unaudited game-derived code", result.unaudited, (row) => row.tag.what);
  say("Malformed game-audit tags", result.invalid, (row) => `line ${row.tag.line}: ${row.tag.what}`);
  say("Game-derived code with no game-audit tag", result.untagged);
  const problems = result.stale.length + result.unaudited.length + result.invalid.length + result.untagged.length;
  if (strict && (problems || !result.game)) process.exitCode = 1;
}
