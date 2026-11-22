// game-audit: n/a prints the server's fight-log figures for a local file; no game data
// The fight-log figures the server keeps (src/fight-log.js), for one of aLogs' fight CSVs, as one JSON line: to compare
// the port with the reference implementation. Not part of the worker; reads a local file only.
// usage: node tools/fight-log-stats.mjs <fight.csv | fight.csv.gz>
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

import { fightStats, parseFightCsv } from "../src/fight-log.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: node tools/fight-log-stats.mjs <fight.csv | fight.csv.gz>");
  process.exit(2);
}
let bytes = await readFile(path);
if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
console.log(JSON.stringify(fightStats(parseFightCsv(new TextDecoder().decode(bytes)))));
