import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { audit, installedGame, readTag } from "../scripts/check-game-audit.mjs";

test("every game-derived file in the site carries a well-formed game-audit tag", () => {
  const result = audit(undefined, null);
  assert.deepEqual(result.untagged.map((row) => row.file), []);
  assert.deepEqual(result.invalid.map((row) => row.file), []);
  // The parts re-checked against game 1.1 say so.
  for (const file of ["public/explorer/damage-model.js", "public/explorer/damage-guide.js", "public/explorer/duel.js"]) {
    const row = result.current.find((entry) => entry.file === file);
    assert.equal(row?.tag.version, "1.1.3857679", file);
  }
});

test("game-audit tags parse, and the check flags older, unaudited and missing tags", () => {
  assert.deepEqual(readTag("// game-audit: 1.1.3857679 2026-11-03 formula 3001"),
    { kind: "audited", version: "1.1.3857679", build: 3857679, date: "2026-11-03", what: "formula 3001", line: 1 });
  assert.equal(readTag("x\n// game-audit: unaudited buffs").kind, "unaudited");
  assert.equal(readTag("// game-audit: 1.1.3857679 yesterday stuff").kind, "invalid");
  assert.equal(readTag("// nothing here"), null);

  const root = mkdtempSync(join(tmpdir(), "game-audit-"));
  mkdirSync(join(root, "public"));
  writeFileSync(join(root, "public", "new.js"), "// game-audit: 1.1.3857679 2026-11-03 formula 3001\n");
  writeFileSync(join(root, "public", "old.js"), "// game-audit: 1.0.3509129 2026-09-20 formula 3001\n");
  writeFileSync(join(root, "public", "todo.js"), "// game-audit: unaudited pet_data roles\n");
  writeFileSync(join(root, "public", "bare.js"), "// reads property_data\n");
  writeFileSync(join(root, "public", "plain.js"), "export const x = 1;\n");
  const result = audit(root, { version: "1.1.3857679", build: 3857679, source: "test" });
  assert.deepEqual(result.current.map((row) => row.file), ["public/new.js"]);
  assert.deepEqual(result.stale.map((row) => row.file), ["public/old.js"]);
  assert.deepEqual(result.unaudited.map((row) => row.file), ["public/todo.js"]);
  assert.deepEqual(result.untagged.map((row) => row.file), ["public/bare.js"]);
});

test("the installed game version comes from LuaCacheVer.txt or the newest game-files map build, else the check skips", () => {
  const game = mkdtempSync(join(tmpdir(), "game-dir-"));
  mkdirSync(join(game, "Aniimo_Data", "cvs", "res", "lua"), { recursive: true });
  writeFileSync(join(game, "Aniimo_Data", "cvs", "res", "lua", "LuaCacheVer.txt"), "1.1.3857679,3104146,abc");
  assert.deepEqual(installedGame({ ANIIMO_GAME_DIR: game }), { version: "1.1.3857679", build: 3857679, source: "LuaCacheVer.txt" });
  const map = mkdtempSync(join(tmpdir(), "game-map-"));
  for (const build of ["3846247", "3857679"]) mkdirSync(join(map, "builds", build), { recursive: true });
  const missing = join(map, "no-game");
  assert.equal(installedGame({ ANIIMO_GAME_DIR: missing, ANIIMO_GAME_MAP: map }).build, 3857679);
  assert.equal(installedGame({ ANIIMO_GAME_DIR: missing }), null);
});
