// game-audit: n/a prints the viewer's lineup rule (src/bots.js lineupBySeat) for runs given on stdin; no game data
// A four-card run's lineup as the site now shows it, rebuilt by seat, to check the rule against stored runs. Not part of
// the worker; reads stdin only. One JSON line in per run, {"players": [...], "lineup": [...]}, one line out:
// {"lineup": [...]} (four entries in seat order), {"lineup": null} for a run without exactly four cards (the name rules
// stay as they were for those), or {"error": "..."} for a line that isn't JSON. Give the lineup as the site passes it
// on (publicLineup) or as stored; Avg DPS isn't added here.
//   node tools/lineup-by-seat.mjs < runs.jsonl
import { createInterface } from "node:readline";
import { lineupBySeat } from "../src/bots.js";

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let run;
  try { run = JSON.parse(line); } catch { console.log(JSON.stringify({ error: "not JSON" })); continue; }
  console.log(JSON.stringify({ lineup: lineupBySeat(run?.players ?? null, run?.lineup ?? null) }));
}
